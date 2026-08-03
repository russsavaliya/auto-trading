'use strict';

const { createClient } = require('@supabase/supabase-js');
const config = require('../config/env');
const logger = require('../utils/logger');

const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: { persistSession: false },
});

const UNIQUE_VIOLATION = '23505';

// ----------------------------------------------------------------------------
// webhook_log
// ----------------------------------------------------------------------------

/**
 * Records an incoming webhook the moment it arrives, before any validation
 * or business logic runs. Every request that hits the endpoint gets a row
 * here — that's the whole point of this table (debugging "did TradingView
 * even send this?").
 */
async function insertWebhookLog(rawPayload) {
  const { data, error } = await supabase
    .from('webhook_log')
    .insert({ raw_payload: rawPayload, processed: false })
    .select('id')
    .single();

  if (error) {
    logger.error({ err: error }, 'Failed to insert webhook_log row');
    return null;
  }
  return data.id;
}

async function updateWebhookLog(id, { processed, reason }) {
  if (id === null || id === undefined) return;
  const { error } = await supabase
    .from('webhook_log')
    .update({ processed, reason: reason ?? null })
    .eq('id', id);

  if (error) {
    logger.error({ err: error, id }, 'Failed to update webhook_log row');
  }
}

// ----------------------------------------------------------------------------
// processed_alerts (idempotency ledger — see sql/schema.sql for the design rationale)
// ----------------------------------------------------------------------------

/**
 * Attempts to record this alert_id as processed. Relies on the PRIMARY KEY
 * constraint on processed_alerts.alert_id for atomicity: if two requests
 * for the same alert_id race, the database — not application logic —
 * guarantees only one insert succeeds.
 *
 * @returns {{inserted: boolean}} inserted=false means this alert_id was already seen.
 */
async function insertProcessedAlert({ alertId, symbol, signalType }) {
  const { error } = await supabase
    .from('processed_alerts')
    .insert({ alert_id: alertId, symbol, signal_type: signalType });

  if (!error) return { inserted: true };

  if (error.code === UNIQUE_VIOLATION) {
    return { inserted: false };
  }

  // Anything else is a real DB problem, not a duplicate — surface it.
  throw error;
}

/**
 * Most recent processed_alerts row for this symbol+signal_type, excluding
 * the given alert_id itself, used for the time-window duplicate check.
 */
async function getLastAlertForSignal({ symbol, signalType, excludeAlertId }) {
  const { data, error } = await supabase
    .from('processed_alerts')
    .select('alert_id, received_at')
    .eq('symbol', symbol)
    .eq('signal_type', signalType)
    .neq('alert_id', excludeAlertId)
    .order('received_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.error({ err: error }, 'Failed to fetch last alert for time-window duplicate check');
    return null;
  }
  return data;
}

// ----------------------------------------------------------------------------
// app_config (kill switch)
// ----------------------------------------------------------------------------

/**
 * Reads the kill switch fresh from Supabase every call — deliberately not
 * cached in memory, so flipping the flag in Supabase takes effect on the
 * very next webhook with no server restart or propagation delay.
 *
 * Fails "paused": if the read itself errors (network blip, RLS
 * misconfiguration, table missing), we fall back to config.tradingEnabledFallback
 * rather than assuming trading is enabled.
 */
async function isTradingEnabled() {
  const { reachable, tradingEnabled } = await getAppConfigStatus();
  if (!reachable) {
    logger.warn('Could not read app_config.trading_enabled — using TRADING_ENABLED env fallback');
    return config.tradingEnabledFallback;
  }
  return tradingEnabled;
}

/**
 * Raw Supabase connectivity + kill-switch check that reports failure instead
 * of swallowing it, used by /health. (isTradingEnabled() above deliberately
 * swallows the same failure to fail "paused" on the trading path — this is
 * the version that lets the health check tell the two situations apart.)
 */
async function getAppConfigStatus() {
  const { data, error } = await supabase
    .from('app_config')
    .select('trading_enabled')
    .eq('id', 1)
    .maybeSingle();

  if (error || !data) {
    return { reachable: false, tradingEnabled: null };
  }
  return { reachable: true, tradingEnabled: data.trading_enabled };
}

// ----------------------------------------------------------------------------
// position_state
// ----------------------------------------------------------------------------

async function getPositionState(symbol) {
  const { data, error } = await supabase
    .from('position_state')
    .select('state, current_trade_id')
    .eq('symbol', symbol)
    .maybeSingle();

  if (error) {
    logger.error({ err: error }, 'Failed to read position_state');
    throw error;
  }
  return data || { state: 'FLAT', current_trade_id: null };
}

/**
 * Atomic compare-and-swap via the set_position_state() Postgres function —
 * see sql/schema.sql for why this has to happen in the database rather than
 * as a JS read-then-write.
 */
async function transitionPositionState({ symbol, expectedState, newState, tradeId = null }) {
  const { data, error } = await supabase.rpc('set_position_state', {
    p_symbol: symbol,
    p_expected_state: expectedState,
    p_new_state: newState,
    p_trade_id: tradeId,
  });

  if (error) {
    logger.error({ err: error }, 'set_position_state RPC failed');
    throw error;
  }

  const row = Array.isArray(data) ? data[0] : data;
  return {
    success: row.success,
    previousState: row.previous_state,
    previousTradeId: row.previous_trade_id,
  };
}

// ----------------------------------------------------------------------------
// trades
// ----------------------------------------------------------------------------

async function insertTrade({ alertId, signalType, symbol, instrumentToken, quantity, entryPrice, scoreAtEntry }) {
  const { data, error } = await supabase
    .from('trades')
    .insert({
      alert_id: alertId,
      signal_type: signalType,
      symbol,
      instrument_token: instrumentToken,
      quantity,
      entry_price: entryPrice,
      score_at_entry: scoreAtEntry,
      status: 'PENDING',
    })
    .select('id')
    .single();

  if (error) {
    logger.error({ err: error }, 'Failed to insert trade row');
    throw error;
  }
  return data.id;
}

async function markTradeFilled(tradeId, { upstoxOrderId }) {
  const { error } = await supabase
    .from('trades')
    .update({ status: 'FILLED', upstox_order_id: upstoxOrderId })
    .eq('id', tradeId);

  if (error) logger.error({ err: error, tradeId }, 'Failed to mark trade FILLED');
}

async function markTradeFailed(tradeId, { errorMessage }) {
  const { error } = await supabase
    .from('trades')
    .update({ status: 'FAILED', error_message: errorMessage })
    .eq('id', tradeId);

  if (error) logger.error({ err: error, tradeId }, 'Failed to mark trade FAILED');
}

async function getTradeById(tradeId) {
  const { data, error } = await supabase
    .from('trades')
    .select('*')
    .eq('id', tradeId)
    .maybeSingle();

  if (error) {
    logger.error({ err: error, tradeId }, 'Failed to fetch trade');
    throw error;
  }
  return data;
}

async function closeTrade(tradeId, { exitPrice, scoreAtExit, exitOrderId, pnl }) {
  const { error } = await supabase
    .from('trades')
    .update({
      status: 'CLOSED',
      exit_price: exitPrice,
      score_at_exit: scoreAtExit,
      exit_order_id: exitOrderId,
      pnl,
      closed_at: new Date().toISOString(),
    })
    .eq('id', tradeId);

  if (error) logger.error({ err: error, tradeId }, 'Failed to close trade');
}

async function recordExitFailure(tradeId, { errorMessage }) {
  const { error } = await supabase
    .from('trades')
    .update({ error_message: errorMessage })
    .eq('id', tradeId);

  if (error) logger.error({ err: error, tradeId }, 'Failed to record exit failure on trade');
}

module.exports = {
  supabase,
  insertWebhookLog,
  updateWebhookLog,
  insertProcessedAlert,
  getLastAlertForSignal,
  isTradingEnabled,
  getAppConfigStatus,
  getPositionState,
  transitionPositionState,
  insertTrade,
  markTradeFilled,
  markTradeFailed,
  getTradeById,
  closeTrade,
  recordExitFailure,
};
