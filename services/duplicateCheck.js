'use strict';

const config = require('../config/env');
const logger = require('../utils/logger');
const supabaseService = require('./supabaseService');

/**
 * Two independent layers of duplicate protection, deliberately different
 * mechanisms so they cover each other's blind spot:
 *
 *  1. HARD check — alert_id uniqueness. TradingView's Pine alert_id is
 *     "bar time + signal type", so the exact same signal firing twice
 *     (TradingView network retry, platform quirk) sends an *identical*
 *     alert_id. Enforced via a database unique constraint (see
 *     supabaseService.insertProcessedAlert), so it's race-safe even if two
 *     requests land at the same instant.
 *
 *  2. SOFT check — time window. Covers the case where something upstream
 *     (a Pine Script bug, a chart re-running on a different bar) produces a
 *     *different* alert_id for what is effectively the same signal fired
 *     moments apart. This is a best-effort heuristic, not atomic — good
 *     enough as a safety net, not a substitute for #1.
 *
 * Either layer tripping means: do not place an order, but still record the
 * alert (webhook_log handles that separately) so it's visible in debugging.
 */
async function checkDuplicate({ alertId, symbol, signalType }) {
  const { inserted } = await supabaseService.insertProcessedAlert({ alertId, symbol, signalType });

  if (!inserted) {
    logger.warn({ alertId, symbol, signalType }, 'Duplicate alert_id — already processed, skipping');
    return { isDuplicate: true, reason: 'duplicate_alert_id' };
  }

  const last = await supabaseService.getLastAlertForSignal({ symbol, signalType, excludeAlertId: alertId });
  if (last) {
    const secondsSinceLast = (Date.now() - new Date(last.received_at).getTime()) / 1000;
    if (secondsSinceLast >= 0 && secondsSinceLast < config.duplicateWindowSeconds) {
      logger.warn(
        { alertId, symbol, signalType, secondsSinceLast, priorAlertId: last.alert_id },
        `Duplicate signal within ${config.duplicateWindowSeconds}s window — skipping`
      );
      return { isDuplicate: true, reason: 'duplicate_time_window' };
    }
  }

  return { isDuplicate: false, reason: null };
}

module.exports = { checkDuplicate };
