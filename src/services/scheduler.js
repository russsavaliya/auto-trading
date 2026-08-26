'use strict';

const config = require('../config/env');
const logger = require('../utils/logger');
const supabaseService = require('./supabaseService');
const tradeExecutor = require('./tradeExecutor');
const marketData = require('./marketData');
const serialQueue = require('../utils/serialQueue');
const marketClock = require('../utils/marketClock');

/**
 * Enforces the intraday rule: a position opened today is closed today.
 *
 * This has to live server-side. The Pine script can only speak when a bar
 * closes and only when its own exit condition is met — if the score never
 * weakens, no exit alert is ever produced and the position simply stays open.
 * That is exactly what happened during the 6-12 Aug paper run: one position
 * was carried from Friday 15:30 to Monday 09:20 (66 hours, across a weekend)
 * and another overnight, and a third was still sitting open days later,
 * blocking every subsequent signal because the state machine was never FLAT.
 *
 * Two triggers:
 *   1. squareOffIst (default 15:15) — close anything still open today.
 *   2. any position whose trade was opened on an EARLIER day gets closed as
 *      soon as the market is open, regardless of time.
 */

const IDX_KEY = { BANKNIFTY: 'NSE_INDEX|Nifty Bank', NIFTY: 'NSE_INDEX|Nifty 50' };

let timer = null;
const lastWarned = new Map();

function warnThrottled(key, payload, msg, everyMs = 15 * 60 * 1000) {
  const now = Date.now();
  if ((lastWarned.get(key) || 0) + everyMs > now) return;
  lastWarned.set(key, now);
  logger.warn(payload, msg);
}

/**
 * Guards against acting on an NSE trading holiday. There is no dependable free
 * holiday feed, so instead of a hardcoded list that silently goes stale we ask
 * the market itself: if the underlying has no candle printed today, nothing is
 * trading and we must not send orders.
 */
async function marketHasTradedToday(symbol) {
  const key = IDX_KEY[symbol];
  if (!key) return true; // unknown underlying — don't block the square-off
  const mark = await marketData.getPremiumAt(key);
  if (!mark) return false;
  return marketClock.istDate(new Date(mark.candleAt).getTime()) === marketClock.istDate();
}

async function considerSymbol(row) {
  const { symbol, state, current_trade_id: tradeId } = row;
  if (state === 'FLAT' || !tradeId) return;

  const now = Date.now();

  if (marketClock.isWeekend(now)) {
    warnThrottled(`weekend:${symbol}`, { symbol, state, tradeId }, 'Position open over the weekend — will square off on the next trading day');
    return;
  }
  if (!marketClock.isMarketOpen(now, config)) {
    warnThrottled(
      `closed:${symbol}`,
      { symbol, state, tradeId, ist: marketClock.istString() },
      'Position still open outside market hours — cannot square off until the market reopens'
    );
    return;
  }

  const trade = await supabaseService.getTradeById(tradeId);
  if (!trade) {
    logger.error({ symbol, tradeId }, 'Position references a trade row that does not exist — needs manual repair');
    return;
  }

  const openedOn = marketClock.istDate(new Date(trade.created_at).getTime());
  const isStale = openedOn !== marketClock.istDate();
  const pastCutoff = marketClock.isPastSquareOff(now, config);

  if (!isStale && !pastCutoff) return;

  if (!(await marketHasTradedToday(symbol))) {
    warnThrottled(`holiday:${symbol}`, { symbol, tradeId }, 'No candle printed today (holiday?) — holding off on square-off');
    return;
  }

  const reason = isStale ? 'stale_overnight' : 'eod_square_off';
  logger.info({ symbol, state, tradeId, openedOn, reason, ist: marketClock.istTime() }, 'Forcing position closed');

  // Same queue the webhooks use, so a square-off can never interleave with an
  // alert being processed for the same symbol.
  const result = await serialQueue.enqueue(symbol, () => tradeExecutor.closePosition({ symbol, reason }));

  if (result.ok) {
    logger.info({ symbol, tradeId: result.tradeId, pnl: result.pnl, reason }, 'Square-off complete');
  } else {
    logger.error({ symbol, tradeId, reason, why: result.reason }, 'Square-off failed — will retry on the next tick');
  }
}

async function tick() {
  try {
    const positions = await supabaseService.listPositionStates();
    for (const row of positions) {
      await considerSymbol(row).catch((err) =>
        logger.error({ err: err.message, symbol: row.symbol }, 'Square-off check failed for symbol')
      );
    }
  } catch (err) {
    logger.error({ err: err.message }, 'Square-off tick failed');
  }
}

function start() {
  if (!config.squareOffEnabled) {
    logger.warn('Square-off scheduler is DISABLED (SQUARE_OFF_ENABLED=false) — positions can be carried overnight');
    return;
  }
  if (timer) return;

  logger.info(
    {
      squareOffIst: config.squareOffIst,
      entryCutoffIst: config.entryCutoffIst,
      pollSeconds: config.squareOffPollSeconds,
    },
    'Square-off scheduler started'
  );

  timer = setInterval(() => {
    tick().catch((err) => logger.error({ err: err.message }, 'Unhandled error in square-off tick'));
  }, config.squareOffPollSeconds * 1000);
  timer.unref();

  // Run once at boot so a restart during the square-off window acts straight
  // away rather than waiting a full poll interval.
  tick().catch((err) => logger.error({ err: err.message }, 'Initial square-off tick failed'));
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick };
