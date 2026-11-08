'use strict';

const config = require('../config/env');
const logger = require('../utils/logger');
const supabaseService = require('./supabaseService');
const tradeExecutor = require('./tradeExecutor');
const marketData = require('./marketData');
const serialQueue = require('../utils/serialQueue');
const marketClock = require('../utils/marketClock');
const modes = require('../config/modes');

/**
 * Books profits and caps losses by watching the OPTION PREMIUM.
 *
 * THE PROBLEM THIS SOLVES
 * Exits used to come only from the Pine score, which is EMA / Supertrend /
 * MACD on the INDEX — all lagging. The premium peaks and round-trips long
 * before the score decays far enough to fire. Over 13-14 Aug 2026:
 *   - 10 of 12 trades were in profit at some point
 *   - those peaks were worth +Rs.7,247 in total
 *   - Rs.11,064 was handed back waiting for the score
 *   - trade 51 was +Rs.1,656 at 12 minutes and closed at -Rs.18 at 60 minutes
 *
 * Three rules, checked in this order (worst case first):
 *   1. stop loss   — premium fell stopLossPct below entry
 *   2. trailing    — armed once trailArmPct in profit, fires on a trailPct
 *                    retrace from the highest premium seen, but never at a
 *                    price below entry + round-trip cost (see
 *                    trailTriggerPrice)
 *   3. time stop   — position has gone nowhere for maxHoldMinutes
 *
 * The Pine exit signal still works and remains the backstop; whichever fires
 * first wins, and the loser is rejected cleanly by the position state CAS.
 *
 * HONEST LIMITS
 * Resolution is one minute (Upstox's finest free candle) and the poll adds up
 * to exitPollSeconds more lag, so a fast spike can be missed entirely — the
 * stop is not a guarantee, it is a best effort. And bounding losses is not an
 * edge: backtested over all 37 trades from 6-14 Aug this turns -Rs.13,061 into
 * -Rs.7,612. Better, still losing. The entry signal is the unsolved problem.
 */

let timer = null;

/**
 * The price at which an armed trailing stop fires.
 *
 * `peak * (1 - trailPct)` alone can sit BELOW the entry price: the trail arms
 * at +trailArmPct (3%) but a trailPct (5%) retrace only stays above entry once
 * the peak is +5.26%. Every peak between those two arms a stop that can only
 * book a loss — 7 of the 23 trades with a recorded peak did exactly that
 * between 17 and 28 Aug.
 *
 * The floor clamps the trigger to entry plus the round-trip friction, so an
 * armed trail exits flat at worst. It is a clamp and not a refusal to arm on
 * purpose: refusing would leave the position running to the time stop or the
 * -10% hard stop, which is a worse tail than the small loss it replaces.
 */
function trailTriggerPrice(entry, peak) {
  const retrace = peak * (1 - config.trailPct);
  if (!config.trailBreakevenFloor) return retrace;
  return Math.max(retrace, entry + config.roundTripCostPoints);
}

/** Returns a reason string when a rule fires, otherwise null. */
function evaluate({ entry, current, peak, heldMinutes }) {
  if (config.stopLossPct > 0 && current <= entry * (1 - config.stopLossPct)) {
    return 'stop_loss';
  }
  if (
    config.trailPct > 0 &&
    peak >= entry * (1 + config.trailArmPct) &&
    current <= trailTriggerPrice(entry, peak)
  ) {
    return 'trailing_stop';
  }
  if (config.maxHoldMinutes > 0 && heldMinutes >= config.maxHoldMinutes) {
    return 'time_stop';
  }
  return null;
}

async function checkTrade(trade) {
  const entry = trade.entry_price == null ? null : Number(trade.entry_price);
  if (!entry || !trade.instrument_token) {
    // An unpriced entry has no basis for a percentage rule. The square-off
    // scheduler still closes it at the end of the day.
    return;
  }

  const mark = await marketData.getPremiumAt(trade.instrument_token);
  if (!mark) {
    // Losing the price feed silently disables the stop-loss on a live
    // position — the single most dangerous failure this service has. Say so
    // loudly rather than looking like a normal quiet poll.
    logger.error(
      { tradeId: trade.id, symbol: trade.symbol, instrumentToken: trade.instrument_token, mode: trade.mode },
      'NO PRICE for an open position — stop-loss and trailing stop are NOT active for it this tick'
    );
    return;
  }

  const current = mark.premium;

  // Keep the sample. Not awaited on purpose: this is analysis data and the
  // stop-loss below must not wait on a write, nor be affected if it fails
  // (insertPremiumSample swallows its own errors and never throws).
  //
  // It has to be recorded live because it cannot be recovered afterwards —
  // Upstox deletes candle history for expired option contracts, which is why
  // only 6 of the first 75 trades could ever be reconstructed.
  void supabaseService.insertPremiumSample(trade.id, current, mark.candleAt);

  const storedPeak = trade.peak_premium == null ? entry : Number(trade.peak_premium);
  const peak = Math.max(storedPeak, current);

  // Persist a new high-water mark before acting on it, so a crash between the
  // two cannot lose the peak and silently disarm the trail.
  if (peak > storedPeak) {
    await supabaseService.updatePeakPremium(trade.id, peak);
  }

  const heldMinutes = (Date.now() - new Date(trade.created_at).getTime()) / 60000;
  const reason = evaluate({ entry, current, peak, heldMinutes });
  if (!reason) return;

  const unrealised = ((current - entry) * Number(trade.quantity)).toFixed(0);
  logger.info(
    {
      tradeId: trade.id,
      symbol: trade.symbol,
      entry,
      current,
      peak,
      heldMinutes: heldMinutes.toFixed(0),
      unrealised,
      reason,
      mode: trade.mode,
    },
    `Premium exit rule fired: ${reason}`
  );

  // Same queue the webhooks and the square-off use, so this can never
  // interleave with an alert being processed for the same symbol.
  const result = await serialQueue.enqueue(trade.symbol, () =>
    tradeExecutor.closePosition({ symbol: trade.symbol, reason, mode: trade.mode || modes.PAPER })
  );

  if (result.ok) {
    logger.info({ tradeId: result.tradeId, pnl: result.pnl, reason }, 'Position closed by premium exit rule');
  } else {
    logger.warn({ tradeId: trade.id, reason, why: result.reason }, 'Premium exit could not close the position');
  }
}

async function tick() {
  if (!marketClock.isMarketOpen(Date.now(), config)) return;

  // Every environment is swept, in its own try/catch. A live position whose
  // token has expired must not stop the paper stop-losses from running — the
  // exit rules are the only thing bounding either book's downside.
  for (const mode of modes.MODES) {
    try {
      const open = await supabaseService.listRunningTrades(mode);
      for (const trade of open) {
        if (trade.status !== 'FILLED') continue;
        await checkTrade(trade).catch((err) =>
          logger.error({ err: err.message, tradeId: trade.id, mode }, 'Premium exit check failed for trade')
        );
      }
    } catch (err) {
      logger.error({ err: err.message, mode }, 'Position monitor tick failed for mode');
    }
  }
}

function start() {
  if (!config.exitRulesEnabled) {
    logger.warn('Premium exit rules are DISABLED (EXIT_RULES_ENABLED=false) — exits will come from the Pine score only');
    return;
  }
  if (timer) return;

  logger.info(
    {
      stopLossPct: config.stopLossPct,
      trailArmPct: config.trailArmPct,
      trailPct: config.trailPct,
      trailBreakevenFloor: config.trailBreakevenFloor,
      roundTripCostPoints: config.roundTripCostPoints,
      maxHoldMinutes: config.maxHoldMinutes,
      pollSeconds: config.exitPollSeconds,
    },
    'Premium exit monitor started'
  );

  timer = setInterval(() => {
    tick().catch((err) => logger.error({ err: err.message }, 'Unhandled error in position monitor tick'));
  }, config.exitPollSeconds * 1000);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick, evaluate, trailTriggerPrice };
