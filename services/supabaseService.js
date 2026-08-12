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
    .select('trading_enabled, entries_enabled')
    .eq('id', 1)
    .maybeSingle();

  // entries_enabled arrives with migration 001. Falling back to the narrower
  // select keeps the health check and the kill switch working on a database
  // where that migration has not been applied yet, so deploy order does not
  // matter — verifySchema() below is what tells you to run it.
  if (error) {
    const { data: legacy, error: legacyErr } = await supabase
      .from('app_config')
      .select('trading_enabled')
      .eq('id', 1)
      .maybeSingle();
    if (legacyErr || !legacy) return { reachable: false, tradingEnabled: null, entriesEnabled: null };
    return { reachable: true, tradingEnabled: legacy.trading_enabled, entriesEnabled: null };
  }

  if (!data) return { reachable: false, tradingEnabled: null, entriesEnabled: null };
  return { reachable: true, tradingEnabled: data.trading_enabled, entriesEnabled: data.entries_enabled };
}

/**
 * Confirms the columns migration 001 adds are actually present, at boot,
 * rather than letting the first real trading signal of the day be the thing
 * that discovers they are missing. Never throws — the server still starts, but
 * it says loudly and specifically what to run.
 */
async function verifySchema() {
  const required = ['entry_spot', 'exit_spot', 'entry_fill_source', 'broker_entry_status', 'closed_reason'];
  const { error } = await supabase.from('trades').select(required.join(', ')).limit(1);

  if (error) {
    logger.error(
      { err: error.message },
      'SCHEMA OUT OF DATE — trades is missing the premium-accounting columns. ' +
        'Run sql/migrations/001_premium_accounting.sql against your Supabase project NOW. ' +
        'Until then, entries will fail and P&L will not be recorded.'
    );
    return { ok: false, error: error.message };
  }
  logger.info('Schema check passed — premium-accounting columns present');
  return { ok: true };
}

/**
 * The narrower switch: pause NEW entries while still letting exits and the
 * square-off through. Flipping the master trading_enabled off mid-session
 * would strand whatever is currently open, which is the opposite of what you
 * want when winding down.
 *
 * Fails OPEN (returns true) only when the column is genuinely absent, so a
 * project that has not run migration 001 yet keeps working unchanged.
 */
async function areEntriesEnabled() {
  const { reachable, entriesEnabled } = await getAppConfigStatus();
  if (!reachable) {
    logger.warn('Could not read app_config.entries_enabled — refusing new entries');
    return false;
  }
  return entriesEnabled !== false;
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

/**
 * Opens a trade row. entry_spot is the INDEX level from the alert; the option
 * premium is not known yet and is written by markTradeOpen once the order has
 * been placed and priced. Keeping the two apart is the whole point of
 * migration 001 — conflating them is what inverted every PUT trade's P&L.
 */
async function insertTrade({ alertId, signalType, symbol, instrumentToken, quantity, entrySpot, scoreAtEntry }) {
  const { data, error } = await supabase
    .from('trades')
    .insert({
      alert_id: alertId,
      signal_type: signalType,
      symbol,
      instrument_token: instrumentToken,
      quantity,
      entry_spot: entrySpot,
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

/**
 * Records the entry premium the position is carried at.
 *
 * status stays 'FILLED' because that is the value listRunningTrades() and the
 * admin dashboard already treat as "position is open" — the honest broker
 * state lives in broker_entry_status, which against the sandbox will read
 * "open pending" forever since it never executes.
 */
async function markTradeOpen(tradeId, { upstoxOrderId, entryPremium, fillSource, brokerStatus }) {
  const { error } = await supabase
    .from('trades')
    .update({
      status: 'FILLED',
      upstox_order_id: upstoxOrderId,
      entry_price: entryPremium,
      entry_fill_source: fillSource,
      broker_entry_status: brokerStatus,
    })
    .eq('id', tradeId);

  if (error) logger.error({ err: error, tradeId }, 'Failed to mark trade open');
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

/**
 * Closes a trade. pnl is computed by the caller from PREMIUMS
 * ((exit_price - entry_price) * quantity) — never from spot levels.
 * closedReason distinguishes a signal exit from a forced square-off, which
 * matters when reviewing whether the strategy or the clock ended the trade.
 */
async function closeTrade(tradeId, { exitPremium, exitSpot, scoreAtExit, exitOrderId, pnl, fillSource, brokerStatus, closedReason }) {
  const { error } = await supabase
    .from('trades')
    .update({
      status: 'CLOSED',
      exit_price: exitPremium,
      exit_spot: exitSpot,
      score_at_exit: scoreAtExit,
      exit_order_id: exitOrderId,
      pnl,
      exit_fill_source: fillSource,
      broker_exit_status: brokerStatus,
      closed_reason: closedReason,
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

/**
 * Most recent webhook_log rows, newest first — the audit trail of every hit
 * to /webhook/tradingview regardless of outcome. Since order placement now
 * runs after the response is already sent (see routes/webhook.js), this is
 * the only place to see whether a given alert actually got processed.
 */
async function listWebhookLogs({ processed, limit = 50, offset = 0 } = {}) {
  let query = supabase
    .from('webhook_log')
    .select('*', { count: 'exact' })
    .order('received_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (processed !== undefined) {
    query = query.eq('processed', processed);
  }

  const { data, error, count } = await query;
  if (error) {
    logger.error({ err: error }, 'Failed to list webhook_log');
    throw error;
  }
  return { logs: data, total: count };
}

// ----------------------------------------------------------------------------
// admin dashboard queries (read-only, used by routes/admin.js)
// ----------------------------------------------------------------------------

async function listTrades({ status, limit = 50, offset = 0 } = {}) {
  let query = supabase
    .from('trades')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) {
    query = query.eq('status', status);
  }

  const { data, error, count } = await query;
  if (error) {
    logger.error({ err: error }, 'Failed to list trades');
    throw error;
  }
  return { trades: data, total: count };
}

async function listRunningTrades() {
  const { data, error } = await supabase
    .from('trades')
    .select('*')
    .in('status', ['PENDING', 'FILLED'])
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Failed to list running trades');
    throw error;
  }
  return data;
}

async function getClosedTradesSince(sinceIso) {
  let query = supabase
    .from('trades')
    .select('id, symbol, signal_type, pnl, quantity, entry_price, exit_price, entry_spot, exit_spot, closed_reason, created_at, closed_at')
    .eq('status', 'CLOSED')
    .order('closed_at', { ascending: true });

  if (sinceIso) {
    query = query.gte('closed_at', sinceIso);
  }

  const { data, error } = await query;
  if (error) {
    logger.error({ err: error }, 'Failed to fetch closed trades');
    throw error;
  }
  return data;
}

async function listPositionStates() {
  const { data, error } = await supabase
    .from('position_state')
    .select('*')
    .order('symbol', { ascending: true });

  if (error) {
    logger.error({ err: error }, 'Failed to list position_state');
    throw error;
  }
  return data;
}

module.exports = {
  supabase,
  listTrades,
  listRunningTrades,
  getClosedTradesSince,
  listPositionStates,
  insertWebhookLog,
  updateWebhookLog,
  listWebhookLogs,
  insertProcessedAlert,
  getLastAlertForSignal,
  isTradingEnabled,
  areEntriesEnabled,
  getAppConfigStatus,
  verifySchema,
  getPositionState,
  transitionPositionState,
  insertTrade,
  markTradeOpen,
  markTradeFailed,
  getTradeById,
  closeTrade,
  recordExitFailure,
};
