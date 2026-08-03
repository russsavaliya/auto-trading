-- ============================================================================
-- TradingView -> Upstox webhook bridge — Supabase schema
-- Run this once against your Supabase project (SQL editor or `psql`).
-- Safe to re-run: everything is guarded with IF NOT EXISTS / ON CONFLICT.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- webhook_log
-- One row per INCOMING webhook call, including rejected/duplicate ones.
-- This is the audit trail for "what did TradingView actually send us and
-- what did we do with it" — invaluable when debugging a missed signal.
-- ----------------------------------------------------------------------------
create table if not exists webhook_log (
  id            bigserial primary key,
  raw_payload   jsonb not null,
  processed     boolean not null default false,
  reason        text,                 -- null when processed normally; set on reject/duplicate/skip/failure
  received_at   timestamptz not null default now()
);

create index if not exists idx_webhook_log_received_at on webhook_log (received_at desc);

-- ----------------------------------------------------------------------------
-- processed_alerts
-- The idempotency ledger. alert_id is PRIMARY KEY, so a second insert with
-- the same alert_id raises a unique-violation (Postgres error 23505) that
-- the app catches and treats as "duplicate, skip". This is done as an
-- INSERT-and-catch rather than SELECT-then-INSERT specifically because the
-- unique constraint makes it atomic under concurrent requests — two webhook
-- calls racing each other cannot both "see no existing row" and both proceed.
-- ----------------------------------------------------------------------------
create table if not exists processed_alerts (
  alert_id      text primary key,
  symbol        text not null,
  signal_type   text not null check (signal_type in ('CALL_ENTRY', 'CALL_EXIT', 'PUT_ENTRY', 'PUT_EXIT')),
  received_at   timestamptz not null default now()
);

-- Powers the "same signal_type for same symbol within N seconds" soft
-- duplicate check, which catches same-signal alerts that arrive with a
-- *different* alert_id (e.g. TradingView re-firing with a new bar timestamp).
create index if not exists idx_processed_alerts_symbol_signal_time
  on processed_alerts (symbol, signal_type, received_at desc);

-- ----------------------------------------------------------------------------
-- trades
-- One row per position (opened on *_ENTRY, closed on the matching *_EXIT).
-- ----------------------------------------------------------------------------
create table if not exists trades (
  id                bigserial primary key,
  alert_id          text not null references processed_alerts (alert_id),
  signal_type       text not null check (signal_type in ('CALL_ENTRY', 'CALL_EXIT', 'PUT_ENTRY', 'PUT_EXIT')),
  symbol            text not null,
  instrument_token  text,             -- exact Upstox instrument traded; needed to place the matching exit order
  quantity          integer,
  entry_price       numeric,
  exit_price        numeric,
  score_at_entry    numeric,
  score_at_exit     numeric,
  upstox_order_id   text,             -- order_id returned when the entry order was placed
  exit_order_id     text,             -- order_id returned when the exit order was placed
  status            text not null default 'PENDING'
                    check (status in ('PENDING', 'FILLED', 'FAILED', 'CLOSED')),
  error_message     text,             -- populated when status = 'FAILED' (or an exit attempt failed)
  pnl               numeric,          -- computed on exit: (exit_price - entry_price) * quantity
  created_at        timestamptz not null default now(),
  closed_at         timestamptz
);

create index if not exists idx_trades_alert_id on trades (alert_id);
create index if not exists idx_trades_symbol_status on trades (symbol, status);

-- ----------------------------------------------------------------------------
-- position_state
-- Current state per symbol, persisted so a server restart doesn't lose it.
-- current_trade_id points at the open trades row so an *_EXIT signal knows
-- exactly which trade it is closing without guessing.
-- ----------------------------------------------------------------------------
create table if not exists position_state (
  symbol            text primary key,
  state             text not null default 'FLAT'
                    check (state in ('FLAT', 'IN_CALL', 'IN_PUT')),
  current_trade_id  bigint references trades (id),
  updated_at        timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- app_config
-- Single-row config table. trading_enabled is the kill switch: flip it to
-- false from the Supabase table editor (or a SQL UPDATE) to immediately
-- stop new orders without touching the server or redeploying.
-- ----------------------------------------------------------------------------
create table if not exists app_config (
  id                smallint primary key default 1,
  trading_enabled   boolean not null default true,
  updated_at        timestamptz not null default now(),
  constraint app_config_singleton check (id = 1)
);

insert into app_config (id, trading_enabled)
values (1, true)
on conflict (id) do nothing;

-- ============================================================================
-- set_position_state — atomic compare-and-swap for position_state.
--
-- Why this needs to be a database function and not "SELECT then UPDATE" in
-- Node: two webhook calls can arrive close together (TradingView retry,
-- or a genuine fast reversal signal). If the app read the state, decided
-- it was safe to proceed, and only then wrote the new state, both requests
-- could read FLAT before either write lands and both would place entry
-- orders. `select ... for update` takes a row lock for the duration of this
-- function's implicit transaction, so the second caller blocks until the
-- first one commits — the second caller then sees the *new* state and
-- correctly fails the compare-and-swap instead of racing.
--
-- Returns success = false (without changing anything) if the row's current
-- state does not match p_expected_state — that's the signal the caller uses
-- to reject an invalid entry ("already in position") or an orphan exit
-- ("not in a position to exit").
-- ============================================================================
create or replace function set_position_state(
  p_symbol          text,
  p_expected_state  text,
  p_new_state       text,
  p_trade_id        bigint default null
) returns table (
  success               boolean,
  previous_state        text,
  previous_trade_id     bigint
) as $$
declare
  v_state     text;
  v_trade_id  bigint;
begin
  -- Lock (or create) the row for this symbol so concurrent calls serialize.
  select state, current_trade_id into v_state, v_trade_id
  from position_state
  where symbol = p_symbol
  for update;

  if not found then
    v_state := 'FLAT';
    v_trade_id := null;
    insert into position_state (symbol, state, current_trade_id, updated_at)
    values (p_symbol, 'FLAT', null, now())
    on conflict (symbol) do nothing;
  end if;

  if v_state <> p_expected_state then
    return query select false, v_state, v_trade_id;
    return;
  end if;

  update position_state
  set state = p_new_state,
      current_trade_id = p_trade_id,
      updated_at = now()
  where symbol = p_symbol;

  return query select true, v_state, v_trade_id;
end;
$$ language plpgsql;
