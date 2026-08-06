'use strict';

const express = require('express');
const logger = require('../utils/logger');
const validateWebhook = require('../middleware/validateWebhook');
const supabaseService = require('../services/supabaseService');
const duplicateCheck = require('../services/duplicateCheck');
const positionState = require('../services/positionState');
const upstoxService = require('../services/upstoxService');
const instrumentResolver = require('../services/instrumentResolver');

const router = express.Router();

const ENTRY_SIGNALS = new Set(['CALL_ENTRY', 'PUT_ENTRY']);
const EXIT_SIGNALS = new Set(['CALL_EXIT', 'PUT_EXIT']);

/** Marks the webhook_log row with the final outcome. Response to TradingView has
 * already gone out by the time this runs — see the route handler below — so this
 * only ever affects the audit trail / admin dashboard, never the HTTP reply. */
async function markLog(webhookLogId, { processed, reason }) {
  await supabaseService.updateWebhookLog(webhookLogId, { processed, reason });
}

async function handleEntry(webhookLogId, payload) {
  const { alertId, symbol, signalType, price, score, quantity, product, orderType } = payload;
  let { instrumentToken } = payload;

  // No instrument_token in the payload -> auto-resolve the current-cycle
  // ATM contract from the underlying price. An explicit instrument_token in
  // the payload is still honored as-is (manual override stays available).
  // Resolved BEFORE the trade row / position reservation exist, so a
  // resolution failure leaves nothing to roll back — just log and bail.
  if (!instrumentToken) {
    try {
      const resolved = await instrumentResolver.resolveEntryInstrument({ signalType, symbol, price });
      instrumentToken = resolved.instrumentToken;
      logger.info({ symbol, signalType, price, resolved }, 'Auto-resolved ATM instrument for entry');
    } catch (err) {
      logger.error({ err: err.message, symbol, signalType, price }, 'ATM instrument resolution failed — no order placed');
      return markLog(webhookLogId, { processed: false, reason: `instrument_resolution_failed: ${err.message}` });
    }
  }

  const tradeId = await supabaseService.insertTrade({
    alertId,
    signalType,
    symbol,
    instrumentToken,
    quantity,
    entryPrice: price,
    scoreAtEntry: score,
  });

  // Reserve the position BEFORE placing the order — see services/positionState.js
  // for why this ordering is what actually prevents double-entries.
  const reservation = await positionState.reserveEntry({ symbol, signalType, tradeId });

  if (!reservation.success) {
    logger.warn({ symbol, signalType, currentState: reservation.previousState }, 'Entry rejected: already in a position');
    await supabaseService.markTradeFailed(tradeId, {
      errorMessage: `Rejected: symbol already ${reservation.previousState}, not FLAT`,
    });
    return markLog(webhookLogId, { processed: false, reason: `invalid_state: already ${reservation.previousState}` });
  }

  try {
    const { orderId } = await upstoxService.placeOrder({
      instrumentToken,
      quantity,
      transactionType: 'BUY',
      product,
      orderType,
      price,
    });

    await supabaseService.markTradeFilled(tradeId, { upstoxOrderId: orderId });
    logger.info({ tradeId, orderId, symbol, signalType }, 'Entry order placed successfully');

    return markLog(webhookLogId, { processed: true, reason: null });
  } catch (err) {
    logger.error({ err: err.message, tradeId, symbol, signalType }, 'Entry order placement failed — rolling back reserved position state');
    await supabaseService.markTradeFailed(tradeId, { errorMessage: err.message });
    // Undo the reservation so we don't get stuck believing we hold a
    // position that was never actually opened at the broker.
    await positionState.rollbackEntry({ symbol, signalType });

    return markLog(webhookLogId, { processed: false, reason: `order_failed: ${err.message}` });
  }
}

async function handleExit(webhookLogId, payload) {
  const { symbol, signalType, price, score, product, orderType } = payload;

  // Reserve FLAT BEFORE placing the order. If the symbol isn't currently on
  // the matching side, this is an orphan/invalid exit signal — reject it.
  const reservation = await positionState.reserveExit({ symbol, signalType });

  if (!reservation.success) {
    logger.warn({ symbol, signalType, currentState: reservation.previousState }, 'Exit rejected: not in a matching position');
    return markLog(webhookLogId, { processed: false, reason: `invalid_state: not in position (current=${reservation.previousState})` });
  }

  const tradeId = reservation.previousTradeId;
  if (!tradeId) {
    // Data-integrity edge case: state said we were in a position but no
    // trade row was linked to it. Nothing to close against — surface loudly
    // rather than guessing at an instrument_token/quantity to sell.
    logger.error({ symbol, signalType }, 'Exit reserved but no linked trade_id found — reverting state');
    await positionState.rollbackExit({ symbol, signalType, tradeId: null });
    return markLog(webhookLogId, { processed: false, reason: 'missing_trade_reference' });
  }

  const trade = await supabaseService.getTradeById(tradeId);

  try {
    const { orderId } = await upstoxService.placeOrder({
      instrumentToken: trade.instrument_token,
      quantity: trade.quantity,
      transactionType: 'SELL',
      product,
      orderType,
      price,
    });

    const pnl = (price - Number(trade.entry_price)) * Number(trade.quantity);
    await supabaseService.closeTrade(tradeId, { exitPrice: price, scoreAtExit: score, exitOrderId: orderId, pnl });
    logger.info({ tradeId, orderId, symbol, signalType, pnl }, 'Exit order placed successfully, trade closed');

    return markLog(webhookLogId, { processed: true, reason: null });
  } catch (err) {
    logger.error({ err: err.message, tradeId, symbol, signalType }, 'Exit order placement failed — rolling back reserved position state');
    await supabaseService.recordExitFailure(tradeId, { errorMessage: err.message });
    // Undo the reservation: the broker never confirmed the exit, so as far
    // as the bridge is concerned the position is still open.
    await positionState.rollbackExit({ symbol, signalType, tradeId });

    return markLog(webhookLogId, { processed: false, reason: `exit_order_failed: ${err.message}` });
  }
}

/**
 * Everything past the initial ack — duplicate check, kill switch, order
 * placement — runs here, after TradingView already has its response. This
 * can take as long as it needs (Upstox retries, backoff, etc.) without ever
 * risking a client-side webhook timeout; the webhook_log row is the only
 * record of how it turned out.
 */
async function processInBackground(webhookLogId, payload) {
  try {
    const { alertId, symbol, signalType } = payload;

    const dup = await duplicateCheck.checkDuplicate({ alertId, symbol, signalType });
    if (dup.isDuplicate) {
      return await markLog(webhookLogId, { processed: false, reason: dup.reason });
    }

    // Checked fresh on every single request — never cached — so toggling
    // app_config.trading_enabled in Supabase takes effect immediately.
    const tradingEnabled = await supabaseService.isTradingEnabled();
    if (!tradingEnabled) {
      logger.warn({ symbol, signalType, alertId }, 'Trading paused (kill switch off) — webhook logged, no order placed');
      return await markLog(webhookLogId, { processed: false, reason: 'trading_disabled' });
    }

    if (ENTRY_SIGNALS.has(signalType)) {
      return await handleEntry(webhookLogId, payload);
    }
    if (EXIT_SIGNALS.has(signalType)) {
      return await handleExit(webhookLogId, payload);
    }

    // Unreachable given validateWebhook's schema check, but keeps this
    // handler safe if that check is ever loosened.
    return await markLog(webhookLogId, { processed: false, reason: `unknown_signal_type: ${signalType}` });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'Unhandled error in background webhook processing');
    try {
      await markLog(webhookLogId, { processed: false, reason: `unhandled_error: ${err.message}` });
    } catch (logErr) {
      logger.error({ err: logErr.message }, 'Failed to record unhandled_error in webhook_log');
    }
  }
}

router.post('/tradingview', validateWebhook, (req, res) => {
  // Ack TradingView immediately — validateWebhook has already persisted the
  // webhook_log row, so the call is durably recorded even if everything below
  // this line crashes. Actual order placement happens after the response is
  // sent, so a slow/retrying Upstox call can never make TradingView time out
  // and mark a real, successfully-processed alert as "failed".
  res.status(200).json({ status: 'received', webhook_log_id: req.webhookLogId });

  processInBackground(req.webhookLogId, req.webhookPayload).catch((err) => {
    logger.error({ err: err.message, stack: err.stack }, 'processInBackground rejected unexpectedly');
  });
});

module.exports = router;
