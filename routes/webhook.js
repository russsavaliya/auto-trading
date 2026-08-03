'use strict';

const express = require('express');
const logger = require('../utils/logger');
const validateWebhook = require('../middleware/validateWebhook');
const supabaseService = require('../services/supabaseService');
const duplicateCheck = require('../services/duplicateCheck');
const positionState = require('../services/positionState');
const upstoxService = require('../services/upstoxService');

const router = express.Router();

const ENTRY_SIGNALS = new Set(['CALL_ENTRY', 'PUT_ENTRY']);
const EXIT_SIGNALS = new Set(['CALL_EXIT', 'PUT_EXIT']);

/** Finalizes the webhook_log row and sends the HTTP response in one place, so no code path forgets one or the other. */
async function finish(req, res, { status, processed, reason, body }) {
  await supabaseService.updateWebhookLog(req.webhookLogId, { processed, reason });
  return res.status(status).json(body);
}

async function handleEntry(req, res) {
  const { alertId, symbol, signalType, price, score, instrumentToken, quantity, product, orderType } = req.webhookPayload;

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
    return finish(req, res, {
      status: 200,
      processed: false,
      reason: `invalid_state: already ${reservation.previousState}`,
      body: { status: 'skipped', reason: 'already_in_position', current_state: reservation.previousState },
    });
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

    return finish(req, res, {
      status: 200,
      processed: true,
      reason: null,
      body: { status: 'order_placed', trade_id: tradeId, order_id: orderId },
    });
  } catch (err) {
    logger.error({ err: err.message, tradeId, symbol, signalType }, 'Entry order placement failed — rolling back reserved position state');
    await supabaseService.markTradeFailed(tradeId, { errorMessage: err.message });
    // Undo the reservation so we don't get stuck believing we hold a
    // position that was never actually opened at the broker.
    await positionState.rollbackEntry({ symbol, signalType });

    return finish(req, res, {
      status: 502,
      processed: false,
      reason: `order_failed: ${err.message}`,
      body: { status: 'order_failed', trade_id: tradeId, error: err.message },
    });
  }
}

async function handleExit(req, res) {
  const { symbol, signalType, price, score, product, orderType } = req.webhookPayload;

  // Reserve FLAT BEFORE placing the order. If the symbol isn't currently on
  // the matching side, this is an orphan/invalid exit signal — reject it.
  const reservation = await positionState.reserveExit({ symbol, signalType });

  if (!reservation.success) {
    logger.warn({ symbol, signalType, currentState: reservation.previousState }, 'Exit rejected: not in a matching position');
    return finish(req, res, {
      status: 200,
      processed: false,
      reason: `invalid_state: not in position (current=${reservation.previousState})`,
      body: { status: 'skipped', reason: 'not_in_position', current_state: reservation.previousState },
    });
  }

  const tradeId = reservation.previousTradeId;
  if (!tradeId) {
    // Data-integrity edge case: state said we were in a position but no
    // trade row was linked to it. Nothing to close against — surface loudly
    // rather than guessing at an instrument_token/quantity to sell.
    logger.error({ symbol, signalType }, 'Exit reserved but no linked trade_id found — reverting state');
    await positionState.rollbackExit({ symbol, signalType, tradeId: null });
    return finish(req, res, {
      status: 500,
      processed: false,
      reason: 'missing_trade_reference',
      body: { status: 'error', message: 'No open trade linked to current position — manual review required' },
    });
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

    return finish(req, res, {
      status: 200,
      processed: true,
      reason: null,
      body: { status: 'position_closed', trade_id: tradeId, order_id: orderId, pnl },
    });
  } catch (err) {
    logger.error({ err: err.message, tradeId, symbol, signalType }, 'Exit order placement failed — rolling back reserved position state');
    await supabaseService.recordExitFailure(tradeId, { errorMessage: err.message });
    // Undo the reservation: the broker never confirmed the exit, so as far
    // as the bridge is concerned the position is still open.
    await positionState.rollbackExit({ symbol, signalType, tradeId });

    return finish(req, res, {
      status: 502,
      processed: false,
      reason: `exit_order_failed: ${err.message}`,
      body: { status: 'order_failed', trade_id: tradeId, error: err.message },
    });
  }
}

router.post('/tradingview', validateWebhook, async (req, res) => {
  // Top-level safety net: no matter what throws below, TradingView always
  // gets a response and the process never crashes on a bad/unexpected input.
  try {
    const { alertId, symbol, signalType } = req.webhookPayload;

    const dup = await duplicateCheck.checkDuplicate({ alertId, symbol, signalType });
    if (dup.isDuplicate) {
      return finish(req, res, {
        status: 200,
        processed: false,
        reason: dup.reason,
        body: { status: 'duplicate_skipped', reason: dup.reason },
      });
    }

    // Checked fresh on every single request — never cached — so toggling
    // app_config.trading_enabled in Supabase takes effect immediately.
    const tradingEnabled = await supabaseService.isTradingEnabled();
    if (!tradingEnabled) {
      logger.warn({ symbol, signalType, alertId }, 'Trading paused (kill switch off) — webhook logged, no order placed');
      return finish(req, res, {
        status: 200,
        processed: false,
        reason: 'trading_disabled',
        body: { status: 'trading_paused', message: 'Kill switch is off — no order placed' },
      });
    }

    if (ENTRY_SIGNALS.has(signalType)) {
      return await handleEntry(req, res);
    }
    if (EXIT_SIGNALS.has(signalType)) {
      return await handleExit(req, res);
    }

    // Unreachable given validateWebhook's schema check, but keeps this
    // handler safe if that check is ever loosened.
    return finish(req, res, {
      status: 400,
      processed: false,
      reason: `unknown_signal_type: ${signalType}`,
      body: { status: 'error', message: `Unknown signal_type: ${signalType}` },
    });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'Unhandled error in webhook handler');
    try {
      await supabaseService.updateWebhookLog(req.webhookLogId, { processed: false, reason: `unhandled_error: ${err.message}` });
    } catch (logErr) {
      logger.error({ err: logErr.message }, 'Failed to record unhandled_error in webhook_log');
    }
    return res.status(500).json({ status: 'error', message: 'Internal error processing webhook' });
  }
});

module.exports = router;
