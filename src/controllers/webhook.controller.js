'use strict';

const config = require('../config/env');
const logger = require('../utils/logger');
const supabaseService = require('../services/supabaseService');
const duplicateCheck = require('../services/duplicateCheck');
const tradeExecutor = require('../services/tradeExecutor');
const upstoxAuth = require('../services/upstoxAuth');
const serialQueue = require('../utils/serialQueue');
const marketClock = require('../utils/marketClock');
const modes = require('../config/modes');

const ENTRY_SIGNALS = new Set(['CALL_ENTRY', 'PUT_ENTRY']);
const EXIT_SIGNALS = new Set(['CALL_EXIT', 'PUT_EXIT']);

/** Marks the webhook_log row with the outcome FOR ONE MODE. The HTTP response
 * to TradingView has already gone out by the time this runs, so this only ever
 * affects the audit trail / admin dashboard. */
async function markLog(webhookLogId, { processed, reason, mode }) {
  await supabaseService.updateWebhookLog(webhookLogId, { processed, reason, mode });
}

async function handleEntry(webhookLogId, payload, mode) {
  const { alertId, symbol, signalType, price, score, quantity, product, orderType, instrumentToken } = payload;

  // ---- session guards -------------------------------------------------
  // Enforced here as well as in Pine because Pine only speaks at bar close and
  // its clock is TradingView's, not ours. During the 6-12 Aug run two
  // positions were opened by the 15:25-15:30 bar, whose alert lands at ~15:31
  // — after the session had ended — and could only be exited the next morning.
  if (marketClock.isPastEntryCutoff(Date.now(), config)) {
    logger.warn(
      { symbol, signalType, mode, ist: marketClock.istTime(), cutoff: config.entryCutoffIst },
      'Entry refused: past the intraday entry cutoff'
    );
    return markLog(webhookLogId, { processed: false, reason: `past_entry_cutoff (${config.entryCutoffIst} IST)`, mode });
  }
  if (!marketClock.isMarketOpen(Date.now(), config)) {
    logger.warn({ symbol, signalType, mode, ist: marketClock.istString() }, 'Entry refused: market is closed');
    return markLog(webhookLogId, { processed: false, reason: 'market_closed', mode });
  }

  const entriesOn = await supabaseService.areEntriesEnabled(mode);
  if (!entriesOn) {
    logger.warn({ symbol, signalType, mode }, 'Entry refused: entries_enabled is off');
    return markLog(webhookLogId, { processed: false, reason: 'entries_disabled', mode });
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
    mode,
  });

  return markLog(webhookLogId, { processed: result.ok, reason: result.ok ? null : result.reason, mode });
}

async function handleExit(webhookLogId, payload, mode) {
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
    mode,
  });

  return markLog(webhookLogId, { processed: result.ok, reason: result.ok ? null : result.reason, mode });
}

/**
 * Which environments this alert should be offered to.
 *
 * Live has to clear three separate gates before it is even attempted, and each
 * failure is reported as its own reason rather than a generic one — the whole
 * point of the split is that "live is off" and "live is broken" must never
 * look the same on the dashboard.
 */
async function resolveLiveGate() {
  if (!config.liveEnabled) return { ok: false, reason: 'live_disabled (LIVE_TRADING_ENABLED is off)' };

  const missing = upstoxAuth.liveCredentialsMissing();
  if (missing.length) return { ok: false, reason: `live_not_configured: missing ${missing.join(', ')}` };

  const token = await upstoxAuth.getAccessToken(modes.LIVE);
  if (!token) {
    return { ok: false, reason: 'live_no_valid_token — reconnect Upstox (tokens expire 03:30 IST daily)' };
  }
  return { ok: true, reason: null };
}

/**
 * One mode's full pipeline for one alert, from dedupe to order.
 *
 * Returns rather than throws. The caller runs the two modes concurrently and
 * an exception escaping here would be the one thing capable of taking the
 * other environment down with it.
 */
async function runMode(webhookLogId, payload, mode) {
  const { alertId, symbol, signalType } = payload;

  try {
    const dup = await duplicateCheck.checkDuplicate({ alertId, symbol, signalType, mode });
    if (dup.isDuplicate) {
      return await markLog(webhookLogId, { processed: false, reason: dup.reason, mode });
    }

    // Read fresh on every request — never cached — so flipping the kill switch
    // in Supabase takes effect on the very next webhook.
    const tradingEnabled = await supabaseService.isTradingEnabled(mode);
    if (!tradingEnabled) {
      logger.warn({ symbol, signalType, alertId, mode }, 'Trading paused (kill switch off) — webhook logged, no order placed');
      return await markLog(webhookLogId, { processed: false, reason: 'trading_disabled', mode });
    }

    if (ENTRY_SIGNALS.has(signalType)) return await handleEntry(webhookLogId, payload, mode);
    if (EXIT_SIGNALS.has(signalType)) return await handleExit(webhookLogId, payload, mode);

    return await markLog(webhookLogId, { processed: false, reason: `unknown_signal_type: ${signalType}`, mode });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack, mode }, `Unhandled error processing the ${mode} side of a webhook`);
    try {
      await markLog(webhookLogId, { processed: false, reason: `unhandled_error: ${err.message}`, mode });
    } catch (logErr) {
      logger.error({ err: logErr.message, mode }, 'Failed to record unhandled_error in webhook_log');
    }
  }
}

/**
 * Everything past the initial ack. Runs after TradingView already has its
 * response, so it can take as long as it needs without risking a client-side
 * webhook timeout; webhook_log is the only record of how it turned out.
 *
 * PAPER AND LIVE RUN CONCURRENTLY AND INDEPENDENTLY.
 *
 * Concurrently, because running live second would add paper's whole round trip
 * — instrument resolution, order, fill poll — to the delay before a real
 * market order is placed, and that delay is paid in slippage.
 *
 * Independently, because the entire reason for two environments is that live
 * is expected to break: a missing token, an unregistered IP, a broker outage.
 * Paper is the only thing currently producing data about the strategy and it
 * has to survive all of that. allSettled (not all) is what guarantees a
 * rejected live promise cannot cancel or mask the paper one.
 */
async function processInBackground(webhookLogId, payload) {
  const tasks = [runMode(webhookLogId, payload, modes.PAPER)];

  const live = await resolveLiveGate();
  if (live.ok) {
    tasks.push(runMode(webhookLogId, payload, modes.LIVE));
  } else {
    // Recorded rather than skipped silently: "live never ran" and "live ran
    // and refused" are different situations and the operator needs to tell
    // them apart from the dashboard alone.
    logger.info({ reason: live.reason, alertId: payload.alertId }, 'Live environment not attempted for this alert');
    tasks.push(markLog(webhookLogId, { processed: false, reason: live.reason, mode: modes.LIVE }));
  }

  const results = await Promise.allSettled(tasks);
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      logger.error({ err: r.reason?.message, mode: i === 0 ? modes.PAPER : modes.LIVE }, 'Mode pipeline rejected unexpectedly');
    }
  });
}

function handleTradingViewAlert(req, res) {
  // Ack immediately — validateWebhook has already persisted the webhook_log
  // row, so the call is durably recorded even if everything below crashes.
  res.status(200).json({ status: 'received', webhook_log_id: req.webhookLogId });

  // Queued per symbol so a reversal's exit always finishes before its entry is
  // attempted. Without this the two race and the entry can be rejected for
  // "not FLAT", silently dropping the new position — see utils/serialQueue.js.
  // The queue orders ALERTS; the two modes inside one alert still run together.
  serialQueue
    .enqueue(req.webhookPayload.symbol, () => processInBackground(req.webhookLogId, req.webhookPayload))
    .catch((err) => {
      logger.error({ err: err.message, stack: err.stack }, 'processInBackground rejected unexpectedly');
    });
}

module.exports = { handleTradingViewAlert };
