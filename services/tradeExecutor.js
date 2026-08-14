'use strict';

const config = require('../config/env');
const logger = require('../utils/logger');
const supabaseService = require('./supabaseService');
const positionState = require('./positionState');
const upstoxService = require('./upstoxService');
const instrumentResolver = require('./instrumentResolver');
const marketData = require('./marketData');

/**
 * The single place a position is opened or closed. Both the TradingView
 * webhook and the end-of-day square-off job go through here, so there is
 * exactly one implementation of "reserve state, place order, price the fill,
 * write the row, roll back on failure" rather than two that drift apart.
 */

const EXIT_SIGNAL_FOR_STATE = { IN_CALL: 'CALL_EXIT', IN_PUT: 'PUT_EXIT' };

// Underlying spot needed to record exit_spot when no alert supplied one (the
// square-off job has no Pine payload). Extend this map for other underlyings.
const INDEX_KEY = { BANKNIFTY: 'NSE_INDEX|Nifty Bank', NIFTY: 'NSE_INDEX|Nifty 50' };

/**
 * Works out what one unit of the option was actually worth for this order.
 *
 * Broker fill wins when there is one — that is ground truth and is what the
 * LIVE API will return. The Upstox sandbox never fills (every order stays
 * "open pending", average_price 0), so in practice this falls through to a
 * mark against the option's real traded price plus a slippage allowance.
 */
async function priceFill({ orderId, instrumentToken, transactionType }) {
  const broker = await upstoxService.getOrderFill(orderId);

  if (broker.isFilled) {
    logger.info({ orderId, averagePrice: broker.averagePrice }, 'Using real broker fill price');
    return { premium: broker.averagePrice, source: 'broker_fill', brokerStatus: broker.brokerStatus };
  }

  const paper = await marketData.getPaperFill({ instrumentToken, transactionType });
  if (!paper) {
    logger.error(
      { orderId, instrumentToken, brokerStatus: broker.brokerStatus },
      'Could not price this fill — no broker fill and no candle data. Trade will be recorded unpriced.'
    );
    return { premium: null, source: 'unpriced', brokerStatus: broker.brokerStatus };
  }
  return { premium: paper.premium, source: paper.source, brokerStatus: broker.brokerStatus };
}

async function currentSpot(symbol) {
  const key = INDEX_KEY[symbol];
  if (!key) return null;
  const mark = await marketData.getPremiumAt(key);
  return mark ? mark.premium : null;
}

/**
 * Opens a position. Returns { ok, reason, tradeId }.
 *
 * Ordering is deliberate and unchanged from the original design: the trade row
 * exists before the state is reserved, and the state is reserved (atomic
 * compare-and-swap) before the broker is called, so a second concurrent signal
 * loses the CAS instead of stacking a second position.
 */
/**
 * Blocks an immediate re-entry after a risk rule closed the last position.
 *
 * Needed because the Pine script re-sends its entry every few bars while the
 * bias holds (so it stays in step after a server-side exit it cannot see). On
 * its own that is fine — but if a stop-loss just fired while the score is still
 * strong, the very next re-assert walks straight back into the same losing
 * trade, and again after the next stop. That is a revenge-trading loop that
 * would turn one bad read into four.
 *
 * A signal-driven exit does NOT trigger this: if the strategy changed its mind
 * and then changed it back, that is a genuine new setup.
 */
const RULE_EXITS = new Set(['stop_loss', 'trailing_stop', 'time_stop']);

async function blockedByRecentRuleExit(symbol, signalType) {
  if (config.reEntryCooldownMinutes <= 0) return null;

  const last = await supabaseService.getLastClosedTrade(symbol);
  if (!last || !RULE_EXITS.has(last.closed_reason)) return null;

  // Only the same direction is blocked — a genuine reversal is still allowed.
  const sameSide = String(last.signal_type).slice(0, 4) === String(signalType).slice(0, 4);
  if (!sameSide) return null;

  const minutesSince = (Date.now() - new Date(last.closed_at).getTime()) / 60000;
  if (minutesSince >= config.reEntryCooldownMinutes) return null;

  return `re_entry_cooldown: ${last.closed_reason} on trade ${last.id} ${minutesSince.toFixed(0)}m ago (need ${config.reEntryCooldownMinutes}m)`;
}

async function openPosition({ alertId, signalType, symbol, spot, score, quantity, product, orderType, instrumentToken }) {
  const cooldown = await blockedByRecentRuleExit(symbol, signalType);
  if (cooldown) {
    logger.warn({ symbol, signalType, cooldown }, 'Entry refused: cooling off after a risk-rule exit');
    return { ok: false, reason: cooldown };
  }

  let token = instrumentToken;

  if (!token) {
    try {
      const resolved = await instrumentResolver.resolveEntryInstrument({ signalType, symbol, price: spot });
      token = resolved.instrumentToken;
      logger.info({ symbol, signalType, spot, resolved }, 'Auto-resolved ATM instrument for entry');
    } catch (err) {
      logger.error({ err: err.message, symbol, signalType, spot }, 'ATM instrument resolution failed — no order placed');
      return { ok: false, reason: `instrument_resolution_failed: ${err.message}` };
    }
  }

  const tradeId = await supabaseService.insertTrade({
    alertId,
    signalType,
    symbol,
    instrumentToken: token,
    quantity,
    entrySpot: spot,
    scoreAtEntry: score,
  });

  const reservation = await positionState.reserveEntry({ symbol, signalType, tradeId });
  if (!reservation.success) {
    logger.warn({ symbol, signalType, currentState: reservation.previousState }, 'Entry rejected: already in a position');
    await supabaseService.markTradeFailed(tradeId, {
      errorMessage: `Rejected: symbol already ${reservation.previousState}, not FLAT`,
    });
    return { ok: false, reason: `invalid_state: already ${reservation.previousState}`, tradeId };
  }

  try {
    const { orderId } = await upstoxService.placeOrder({
      instrumentToken: token,
      quantity,
      transactionType: 'BUY',
      product,
      orderType,
      price: spot,
    });

    const fill = await priceFill({ orderId, instrumentToken: token, transactionType: 'BUY' });
    await supabaseService.markTradeOpen(tradeId, {
      upstoxOrderId: orderId,
      entryPremium: fill.premium,
      fillSource: fill.source,
      brokerStatus: fill.brokerStatus,
    });

    logger.info(
      { tradeId, orderId, symbol, signalType, entryPremium: fill.premium, fillSource: fill.source },
      'Position opened'
    );
    return { ok: true, tradeId, entryPremium: fill.premium };
  } catch (err) {
    logger.error({ err: err.message, tradeId, symbol, signalType }, 'Entry order failed — rolling back reserved state');
    await supabaseService.markTradeFailed(tradeId, { errorMessage: err.message });
    await positionState.rollbackEntry({ symbol, signalType });
    return { ok: false, reason: `order_failed: ${err.message}`, tradeId };
  }
}

/**
 * Closes whatever is currently open on `symbol`.
 *
 * `signalType` is optional: pass CALL_EXIT/PUT_EXIT when acting on an alert so
 * a mismatched exit (a CALL_EXIT arriving while IN_PUT) is correctly rejected.
 * Omit it — as the square-off job does — to close whichever side is open.
 */
async function closePosition({ symbol, signalType = null, spot = null, score = null, product, orderType, reason = 'signal' }) {
  let exitSignal = signalType;

  if (!exitSignal) {
    const state = await positionState.getState(symbol);
    exitSignal = EXIT_SIGNAL_FOR_STATE[state.state];
    if (!exitSignal) return { ok: false, reason: `nothing_to_close: state=${state.state}` };
  }

  const reservation = await positionState.reserveExit({ symbol, signalType: exitSignal });
  if (!reservation.success) {
    logger.warn({ symbol, signalType: exitSignal, currentState: reservation.previousState }, 'Exit rejected: not in a matching position');
    return { ok: false, reason: `invalid_state: not in position (current=${reservation.previousState})` };
  }

  const tradeId = reservation.previousTradeId;
  if (!tradeId) {
    logger.error({ symbol, signalType: exitSignal }, 'Exit reserved but no linked trade_id — reverting state');
    await positionState.rollbackExit({ symbol, signalType: exitSignal, tradeId: null });
    return { ok: false, reason: 'missing_trade_reference' };
  }

  const trade = await supabaseService.getTradeById(tradeId);

  try {
    const { orderId } = await upstoxService.placeOrder({
      instrumentToken: trade.instrument_token,
      quantity: trade.quantity,
      transactionType: 'SELL',
      product: product || config.defaultProduct,
      orderType: orderType || config.defaultOrderType,
      price: spot || 0,
    });

    const fill = await priceFill({ orderId, instrumentToken: trade.instrument_token, transactionType: 'SELL' });
    const exitSpot = spot != null ? spot : await currentSpot(symbol);

    // P&L comes from PREMIUM only. If either leg is unpriced we store null
    // rather than a number we cannot stand behind — a missing figure is
    // recoverable, a fabricated one silently corrupts every summary above it.
    const entryPremium = trade.entry_price == null ? null : Number(trade.entry_price);
    const pnl =
      fill.premium != null && entryPremium != null
        ? Number(((fill.premium - entryPremium) * Number(trade.quantity)).toFixed(2))
        : null;

    await supabaseService.closeTrade(tradeId, {
      exitPremium: fill.premium,
      exitSpot,
      scoreAtExit: score,
      exitOrderId: orderId,
      pnl,
      fillSource: fill.source,
      brokerStatus: fill.brokerStatus,
      closedReason: reason,
    });

    logger.info(
      { tradeId, orderId, symbol, entryPremium, exitPremium: fill.premium, pnl, reason },
      'Position closed'
    );
    return { ok: true, tradeId, pnl };
  } catch (err) {
    logger.error({ err: err.message, tradeId, symbol }, 'Exit order failed — rolling back reserved state');
    await supabaseService.recordExitFailure(tradeId, { errorMessage: err.message });
    await positionState.rollbackExit({ symbol, signalType: exitSignal, tradeId });
    return { ok: false, reason: `exit_order_failed: ${err.message}`, tradeId };
  }
}

module.exports = { openPosition, closePosition };
