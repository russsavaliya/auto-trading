'use strict';

const { createClient } = require('@supabase/supabase-js');
const config = require('../config/env');
const logger = require('../utils/logger');
const marketClock = require('../utils/marketClock');

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
  const required = ['entry_spot', 'exit_spot', 'entry_fill_source', 'broker_entry_status', 'closed_reason', 'peak_premium'];
  const { error } = await supabase.from('trades').select(required.join(', ')).limit(1);

  if (error) {
    logger.error(
      { err: error.message },
      'SCHEMA OUT OF DATE — trades is missing required columns. ' +
        'Run every file in sql/migrations/ against your Supabase project NOW (001 then 002). ' +
        'Until then, entries will fail, P&L will not be recorded, and the exit rules will not run.'
    );
    return { ok: false, error: error.message };
  }
  logger.info('Schema check passed — premium-accounting columns present');

  // Migration 003 is optional for trading — the exit rules work without it —
  // but every poll it is missing is a premium path that can never be recovered,
  // so say so once at boot rather than letting it stay silently off.
  const { error: samplesErr } = await supabase.from('trade_premium_samples').select('id').limit(1);
  if (samplesErr) {
    logger.warn(
      'trade_premium_samples is missing — run sql/migrations/003_premium_samples.sql. ' +
        'Trading is unaffected, but the premium path of every trade is being discarded, ' +
        'and Upstox cannot supply it later for expired contracts.'
    );
  } else {
    logger.info('Premium path recording is active (migration 003 present)');
  }

  // Migration 004 adds the cost columns and the runtime-config knobs. Trading
  // works without it — charges simply stay null and the cap falls back to the
  // env value — but the Report page cannot show net P&L until it is applied.
  const { error: chargesErr } = await supabase.from('trades').select('charges').limit(1);
  if (chargesErr) {
    logger.warn(
      'trades.charges is missing — run sql/migrations/004_charges_and_runtime_config.sql. ' +
        'Until then every P&L stays GROSS, the Report page cannot show net, and the ' +
        'Settings page cannot change the daily cap.'
    );
  } else {
    logger.info('Charge accounting and runtime config are active (migration 004 present)');
  }

  return { ok: true };
}

/**
 * Flips the kill switch from the admin dashboard. Writes straight through to
 * Supabase — no in-memory cache — so the same guarantee as isTradingEnabled()
 * applies in reverse: the very next webhook after this resolves sees the new
 * value.
 */
async function setTradingEnabled(enabled) {
  const { data, error } = await supabase
    .from('app_config')
    .update({ trading_enabled: enabled, updated_at: new Date().toISOString() })
    .eq('id', 1)
    .select('trading_enabled')
    .single();

  if (error) {
    logger.error({ err: error }, 'Failed to update app_config.trading_enabled');
    throw new Error('Failed to update trading_enabled');
  }
  return data;
}

/**
 * Everything the trading path is allowed to change at runtime, in one read.
 *
 * These used to be env vars, which on Render means a redeploy — so the daily
 * cap could not be adjusted while the market was open, which is the only time
 * anyone wants to adjust it. They now live beside trading_enabled.
 *
 * FALLS BACK TO ENV, never throws. A config read that fails must not decide
 * "cap is 0, trade freely" — the env defaults are the same values the row was
 * seeded with, so an unreadable row behaves exactly like an unedited one.
 * (The kill switch keeps its own separate, fail-paused path in
 * isTradingEnabled() — this function is for the numeric knobs only.)
 */
async function getRuntimeConfig() {
  const fallback = {
    maxTradesPerDay: config.maxTradesPerDay,
    reEntryCooldownEnabled: config.reEntryCooldownMinutes > 0,
    reEntryCooldownMinutes: config.reEntryCooldownMinutes,
    source: 'env-fallback',
  };

  const { data, error } = await supabase
    .from('app_config')
    .select('max_trades_per_day, re_entry_cooldown_enabled, re_entry_cooldown_minutes')
    .eq('id', 1)
    .maybeSingle();

  if (error || !data) {
    logger.warn(
      { err: error?.message },
      'Could not read runtime config from app_config — using env defaults. Run sql/migrations/004_charges_and_runtime_config.sql.'
    );
    return fallback;
  }

  return {
    maxTradesPerDay: Number(data.max_trades_per_day),
    reEntryCooldownEnabled: Boolean(data.re_entry_cooldown_enabled),
    reEntryCooldownMinutes: Number(data.re_entry_cooldown_minutes),
    source: 'db',
  };
}

/**
 * Applies a validated patch from the Settings page. Only the three keys below
 * are writable; anything else in the body is ignored rather than passed
 * through, so a malformed request can never reach a column it should not.
 * Range checking happens in controllers/config.controller.js.
 */
async function setRuntimeConfig(patch) {
  const COLUMNS = {
    maxTradesPerDay: 'max_trades_per_day',
    reEntryCooldownEnabled: 're_entry_cooldown_enabled',
    reEntryCooldownMinutes: 're_entry_cooldown_minutes',
  };

  const update = {};
  for (const [key, column] of Object.entries(COLUMNS)) {
    if (patch[key] !== undefined) update[column] = patch[key];
  }
  if (!Object.keys(update).length) return getRuntimeConfig();

  update.updated_at = new Date().toISOString();

  const { error } = await supabase.from('app_config').update(update).eq('id', 1);
  if (error) {
    logger.error({ err: error, update }, 'Failed to update runtime config');
    throw new Error('Failed to update settings');
  }
  logger.info({ update }, 'Runtime config updated from the dashboard');
  return getRuntimeConfig();
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
/**
 * `pnl` stays GROSS here, and `charges` is stored beside it rather than netted
 * into it. Two reasons, both about not rewriting history:
 *   - every existing row, the summary endpoint and the equity curve already
 *     mean "gross" by that column; silently changing what it holds would make
 *     old and new rows incomparable with no way to tell them apart;
 *   - the charge that applied is a fact about the day the trade closed, and
 *     statutory rates move. Net is a subtraction anyone can do; an overwritten
 *     gross figure is gone.
 * The Report page shows gross, cost and net side by side for exactly this
 * reason — see controllers/pnl.controller.js.
 */
async function closeTrade(tradeId, { exitPremium, exitSpot, scoreAtExit, exitOrderId, pnl, fillSource, brokerStatus, closedReason, charges, chargesBreakdown }) {
  const { error } = await supabase
    .from('trades')
    .update({
      status: 'CLOSED',
      exit_price: exitPremium,
      exit_spot: exitSpot,
      score_at_exit: scoreAtExit,
      exit_order_id: exitOrderId,
      pnl,
      charges: charges ?? null,
      charges_breakdown: chargesBreakdown ?? null,
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

/**
 * Records a new high-water mark for the trailing stop. Persisted rather than
 * kept in memory so a restart mid-position cannot reset the peak to the entry
 * price and silently disarm the trail.
 */
async function updatePeakPremium(tradeId, peakPremium) {
  const { error } = await supabase
    .from('trades')
    .update({ peak_premium: peakPremium })
    .eq('id', tradeId);

  if (error) logger.error({ err: error, tradeId }, 'Failed to update peak_premium');
}

/**
 * Appends one point of an open position's premium path.
 *
 * Fire-and-forget by design: this is analysis data, and a failure to record it
 * must never propagate into the monitor tick that is also running the
 * stop-loss. Errors are logged at debug, not error — if the table has not been
 * created yet (migration 003) every poll would otherwise spam the log for a
 * feature that has no effect on trading.
 *
 * Cannot be rebuilt later — Upstox deletes candle history for expired option
 * contracts, so a sample not taken now is gone. See the migration for the
 * measurement.
 */
async function insertPremiumSample(tradeId, premium, candleAt) {
  try {
    const { error } = await supabase
      .from('trade_premium_samples')
      .insert({ trade_id: tradeId, premium, candle_at: candleAt || null });
    if (error) logger.debug({ err: error.message, tradeId }, 'Could not record premium sample');
  } catch (err) {
    logger.debug({ err: err.message, tradeId }, 'Could not record premium sample');
  }
}

/**
 * How many positions this symbol has already opened today, in IST.
 *
 * FAILED rows are excluded on purpose: insertTrade() writes the row before the
 * broker is called, so a rejected order leaves a row behind that never became
 * a position. Counting those against the daily cap would silently burn the
 * day's allowance on trades that never happened.
 *
 * The day boundary must be IST, not the server's local midnight — Render runs
 * in UTC, where "today" starts at 05:30 IST and the first 5.5 hours of every
 * session would be counted against the previous day.
 */
async function countTradesToday(symbol) {
  const startOfDayIst = new Date(`${marketClock.istDate()}T00:00:00+05:30`).toISOString();

  const { count, error } = await supabase
    .from('trades')
    .select('id', { count: 'exact', head: true })
    .eq('symbol', symbol)
    .in('status', ['PENDING', 'FILLED', 'CLOSED'])
    .gte('created_at', startOfDayIst);

  if (error) {
    // Fail CLOSED: if the count cannot be read we do not know how many trades
    // have already run, and quietly allowing another one is the riskier guess.
    logger.error({ err: error, symbol }, 'Failed to count today\'s trades — treating the daily cap as reached');
    return Number.POSITIVE_INFINITY;
  }
  return count ?? 0;
}

/** Most recently closed trade for a symbol — drives the re-entry cooldown. */
async function getLastClosedTrade(symbol) {
  const { data, error } = await supabase
    .from('trades')
    .select('id, signal_type, closed_reason, closed_at, pnl')
    .eq('symbol', symbol)
    .eq('status', 'CLOSED')
    .not('closed_at', 'is', null)
    .order('closed_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.error({ err: error, symbol }, 'Failed to read last closed trade');
    return null;
  }
  return data;
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

const CLOSED_TRADE_COLUMNS =
  'id, symbol, signal_type, pnl, quantity, entry_price, exit_price, entry_spot, exit_spot, closed_reason, created_at, closed_at';

async function getClosedTradesSince(sinceIso) {
  const run = (columns) => {
    let query = supabase
      .from('trades')
      .select(columns)
      .eq('status', 'CLOSED')
      .order('closed_at', { ascending: true });
    if (sinceIso) query = query.gte('closed_at', sinceIso);
    return query;
  };

  // The charge columns arrive with migration 004. Selecting a column that does
  // not exist fails the WHOLE query, so a deploy that landed before the
  // migration was applied would take the summary, the equity curve and the
  // daily chart down with it — not just the new Report page. Falling back to
  // the narrower select keeps every existing screen working; the Report page
  // then recomputes charges from the premiums instead. Same reasoning, and the
  // same shape, as the entries_enabled fallback in getAppConfigStatus().
  let { data, error } = await run(`${CLOSED_TRADE_COLUMNS}, charges, charges_breakdown`);
  if (error) {
    ({ data, error } = await run(CLOSED_TRADE_COLUMNS));
  }

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
  setTradingEnabled,
  areEntriesEnabled,
  getAppConfigStatus,
  verifySchema,
  getPositionState,
  transitionPositionState,
  insertTrade,
  markTradeOpen,
  updatePeakPremium,
  insertPremiumSample,
  getRuntimeConfig,
  setRuntimeConfig,
  countTradesToday,
  getLastClosedTrade,
  markTradeFailed,
  getTradeById,
  closeTrade,
  recordExitFailure,
};
