'use strict';

const express = require('express');
const config = require('../config/env');
const logger = require('../utils/logger');
const validateWebhook = require('../middleware/validateWebhook');
const supabaseService = require('../services/supabaseService');
const duplicateCheck = require('../services/duplicateCheck');
const tradeExecutor = require('../services/tradeExecutor');
const serialQueue = require('../utils/serialQueue');
const marketClock = require('../utils/marketClock');

const router = express.Router();

const ENTRY_SIGNALS = new Set(['CALL_ENTRY', 'PUT_ENTRY']);
const EXIT_SIGNALS = new Set(['CALL_EXIT', 'PUT_EXIT']);

/** Marks the webhook_log row with the final outcome. The HTTP response to
 * TradingView has already gone out by the time this runs, so this only ever
 * affects the audit trail / admin dashboard. */
async function markLog(webhookLogId, { processed, reason }) {
  await supabaseService.updateWebhookLog(webhookLogId, { processed, reason });
}

async function handleEntry(webhookLogId, payload) {
  const { alertId, symbol, signalType, price, score, quantity, product, orderType, instrumentToken } = payload;

  // ---- session guards -------------------------------------------------
  // Enforced here as well as in Pine because Pine only speaks at bar close and
  // its clock is TradingView's, not ours. During the 6-12 Aug run two
  // positions were opened by the 15:25-15:30 bar, whose alert lands at ~15:31
  // — after the session had ended — and could only be exited the next morning.
  if (marketClock.isPastEntryCutoff(Date.now(), config)) {
    logger.warn(
      { symbol, signalType, ist: marketClock.istTime(), cutoff: config.entryCutoffIst },
      'Entry refused: past the intraday entry cutoff'
    );
    return markLog(webhookLogId, { processed: false, reason: `past_entry_cutoff (${config.entryCutoffIst} IST)` });
  }
  if (!marketClock.isMarketOpen(Date.now(), config)) {
    logger.warn({ symbol, signalType, ist: marketClock.istString() }, 'Entry refused: market is closed');
    return markLog(webhookLogId, { processed: false, reason: 'market_closed' });
  }

  const entriesOn = await supabaseService.areEntriesEnabled();
  if (!entriesOn) {
    logger.warn({ symbol, signalType }, 'Entry refused: entries_enabled is off');
    return markLog(webhookLogId, { processed: false, reason: 'entries_disabled' });
  }

  const result = await tradeExecutor.openPosition({
    alertId,
    signalType,
    symbol,
    spot: price,
    score,
    quantity,
    product,
    orderType,
    instrumentToken,
  });

  return markLog(webhookLogId, { processed: result.ok, reason: result.ok ? null : result.reason });
}

async function handleExit(webhookLogId, payload) {
  const { symbol, signalType, price, score, product, orderType } = payload;

  // Exits are never blocked by the session guards or by entries_enabled — if a
  // position is open it must always be closeable.
  const result = await tradeExecutor.closePosition({
    symbol,
    signalType,
    spot: price,
    score,
    product,
    orderType,
    reason: 'signal',
  });

  return markLog(webhookLogId, { processed: result.ok, reason: result.ok ? null : result.reason });
}

/**
 * Everything past the initial ack. Runs after TradingView already has its
 * response, so it can take as long as it needs without risking a client-side
 * webhook timeout; webhook_log is the only record of how it turned out.
 */
async function processInBackground(webhookLogId, payload) {
  try {
    const { alertId, symbol, signalType } = payload;

    const dup = await duplicateCheck.checkDuplicate({ alertId, symbol, signalType });
    if (dup.isDuplicate) {
      return await markLog(webhookLogId, { processed: false, reason: dup.reason });
    }

    // Read fresh on every request — never cached — so flipping the kill switch
    // in Supabase takes effect on the very next webhook.
    const tradingEnabled = await supabaseService.isTradingEnabled();
    if (!tradingEnabled) {
      logger.warn({ symbol, signalType, alertId }, 'Trading paused (kill switch off) — webhook logged, no order placed');
      return await markLog(webhookLogId, { processed: false, reason: 'trading_disabled' });
    }

    if (ENTRY_SIGNALS.has(signalType)) return await handleEntry(webhookLogId, payload);
    if (EXIT_SIGNALS.has(signalType)) return await handleExit(webhookLogId, payload);

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
  // Ack immediately — validateWebhook has already persisted the webhook_log
  // row, so the call is durably recorded even if everything below crashes.
  res.status(200).json({ status: 'received', webhook_log_id: req.webhookLogId });

  // Queued per symbol so a reversal's exit always finishes before its entry is
  // attempted. Without this the two race and the entry can be rejected for
  // "not FLAT", silently dropping the new position — see utils/serialQueue.js.
  serialQueue
    .enqueue(req.webhookPayload.symbol, () => processInBackground(req.webhookLogId, req.webhookPayload))
    .catch((err) => {
      logger.error({ err: err.message, stack: err.stack }, 'processInBackground rejected unexpectedly');
    });
});

module.exports = router;
