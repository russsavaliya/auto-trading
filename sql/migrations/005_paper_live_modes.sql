-- ============================================================================
-- Migration 005 — two trading environments side by side: paper and live
--
-- WHY
-- Live trading needs a static IP, a daily-rotating token and an OAuth flow
-- that does not exist yet (see docs/GO_LIVE.md). Any of those can break for
-- days at a time. Paper trading must keep running through all of it — it is
-- the only thing currently producing data about the strategy.
--
-- So the two are separated at the DATA level, not by running a second copy of
-- the app. One TradingView alert fans out to both modes; each keeps its own
-- position state, its own daily cap, its own kill switch and its own trades.
-- A live outage cannot touch a paper position, and the dashboard can show
-- either environment without the numbers ever mixing.
--
-- THE DEFAULT IS 'paper' EVERYWHERE, ON PURPOSE.
-- Every column, function argument and code path added here defaults to paper.
-- That means any query, RPC call or code branch that this migration failed to
-- update keeps behaving exactly as it does today rather than silently reading
-- or writing live data. Migrating should change no paper behaviour at all.
--
-- ONE CONFUSING ERROR, DOCUMENTED SO NOBODY CHASES IT
-- Until this migration is applied, any query filtering on `mode` fails with
--     42809  WITHIN GROUP is required for ordered-set aggregate mode
-- rather than the expected "column does not exist". That is Postgres reading
-- `trades.mode` as the functional notation `mode(trades)` and finding the
-- built-in ordered-set aggregate of that name. Once the column exists the
-- column shadows the function and it resolves normally. verifySchema() in
-- services/supabaseService.js translates this into a readable message.
--
-- Safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. trades — which environment placed this
-- ---------------------------------------------------------------------------
alter table trades add column if not exists mode text not null default 'paper';

do $$ begin
  alter table trades add constraint trades_mode_check check (mode in ('paper', 'live'));
exception when duplicate_object then null; end $$;

create index if not exists idx_trades_mode_status on trades (mode, status);
create index if not exists idx_trades_mode_closed_at on trades (mode, closed_at desc);

comment on column trades.mode is
  'paper = Upstox sandbox + marked fills. live = real money. Every P&L query must filter on this; a report that mixes them is meaningless.';

-- ---------------------------------------------------------------------------
-- 2. processed_alerts — the dedupe ledger is now PER MODE
--
-- One TradingView alert must be allowed to open a paper position AND a live
-- position. With alert_id alone as the primary key the second mode would be
-- rejected as a duplicate of the first, and live would never trade at all.
-- ---------------------------------------------------------------------------
alter table processed_alerts add column if not exists mode text not null default 'paper';

do $$ begin
  alter table processed_alerts add constraint processed_alerts_mode_check check (mode in ('paper', 'live'));
exception when duplicate_object then null; end $$;

-- trades.alert_id references this table, so the FK has to move with the key.
do $$ begin
  alter table trades drop constraint trades_alert_id_fkey;
exception when undefined_object then null; end $$;

do $$ begin
  alter table processed_alerts drop constraint processed_alerts_pkey;
exception when undefined_object then null; end $$;

do $$ begin
  alter table processed_alerts add constraint processed_alerts_pkey primary key (alert_id, mode);
exception when duplicate_table then null; when invalid_table_definition then null; end $$;

do $$ begin
  alter table trades add constraint trades_alert_id_mode_fkey
    foreign key (alert_id, mode) references processed_alerts (alert_id, mode);
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 3. position_state — a symbol can be IN_CALL on paper and FLAT on live
-- ---------------------------------------------------------------------------
alter table position_state add column if not exists mode text not null default 'paper';

do $$ begin
  alter table position_state add constraint position_state_mode_check check (mode in ('paper', 'live'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table position_state drop constraint position_state_pkey;
exception when undefined_object then null; end $$;

do $$ begin
  alter table position_state add constraint position_state_pkey primary key (symbol, mode);
exception when duplicate_table then null; when invalid_table_definition then null; end $$;

-- ---------------------------------------------------------------------------
-- 4. webhook_log — one inbound call, now two outcomes
--
-- `processed` / `reason` keep meaning the PAPER outcome. Every one of the 200+
-- existing rows already means that, and the dashboard, the Webhook Logs page
-- and every past investigation read them that way — redefining the column
-- would make old and new rows silently incomparable. Live gets its own pair.
--
-- Two modes is a fixed, small set, not an open-ended list, so a column pair is
-- the honest shape here rather than a child table nobody would join.
-- ---------------------------------------------------------------------------
alter table webhook_log add column if not exists live_processed boolean;
alter table webhook_log add column if not exists live_reason    text;

comment on column webhook_log.processed is
  'PAPER outcome. True when a paper order was placed. See live_processed for the live environment.';
comment on column webhook_log.live_processed is
  'LIVE outcome. NULL means live was disabled or not configured when this alert arrived — distinct from false, which means live actively refused it.';

-- ---------------------------------------------------------------------------
-- 5. app_config — one row per mode instead of a singleton
--
-- The existing row becomes the paper row untouched, so paper keeps every
-- setting it has now. Live is seeded with trading DISABLED: a migration must
-- never be the thing that starts trading real money.
-- ---------------------------------------------------------------------------
alter table app_config add column if not exists mode text not null default 'paper';

do $$ begin
  alter table app_config drop constraint app_config_singleton;
exception when undefined_object then null; end $$;

do $$ begin
  alter table app_config add constraint app_config_mode_check check (mode in ('paper', 'live'));
exception when duplicate_object then null; end $$;

create unique index if not exists idx_app_config_mode on app_config (mode);

update app_config set mode = 'paper' where id = 1 and mode is distinct from 'paper';

insert into app_config (id, mode, trading_enabled, max_trades_per_day, re_entry_cooldown_enabled, re_entry_cooldown_minutes)
values (2, 'live', false, 1, true, 15)
on conflict (id) do nothing;

-- entries_enabled arrives with migration 001 and may not exist on very old
-- databases; set it only if the column is there.
do $$ begin
  update app_config set entries_enabled = false where mode = 'live' and entries_enabled is null;
exception when undefined_column then null; end $$;

-- ---------------------------------------------------------------------------
-- 6. broker_tokens — where the live access token lives
--
-- The live Upstox access token expires at 3:30 AM IST every single day,
-- whenever it was issued. It cannot sit in an env var the way the 30-day
-- sandbox token does: a Render env change is a redeploy, and doing that daily
-- before the market opens is not an operational plan.
--
-- Storing it here means the running server can pick up a refreshed token
-- without a restart, the dashboard can show how long is left on it, and the
-- 2 Sep 2026 failure — six hours of silent 401s because nobody knew the token
-- had died — becomes visible instead of invisible.
-- ---------------------------------------------------------------------------
create table if not exists broker_tokens (
  mode           text primary key check (mode in ('paper', 'live')),
  access_token   text,
  -- Upstox does not issue refresh tokens for the standard daily flow; this is
  -- kept for the extended-token flow and stays null otherwise.
  refresh_token  text,
  expires_at     timestamptz,
  user_id        text,
  updated_at     timestamptz not null default now(),
  last_error     text
);

comment on table broker_tokens is
  'Live broker credentials, refreshed daily. Never expose access_token through any API response — the admin dashboard only ever receives expires_at and a boolean.';

-- ---------------------------------------------------------------------------
-- 7. set_position_state — same compare-and-swap, now scoped to a mode
--
-- Dropped and recreated because the argument list changes. p_mode DEFAULTS to
-- 'paper', so any caller this migration missed still hits the paper row rather
-- than colliding with live state.
-- ---------------------------------------------------------------------------
drop function if exists set_position_state(text, text, text, bigint);
drop function if exists set_position_state(text, text, text, bigint, text);

create or replace function set_position_state(
  p_symbol          text,
  p_expected_state  text,
  p_new_state       text,
  p_trade_id        bigint default null,
  p_mode            text default 'paper'
) returns table (
  success               boolean,
  previous_state        text,
  previous_trade_id     bigint
) as $$
declare
  v_state     text;
  v_trade_id  bigint;
begin
  -- Lock (or create) the row for this symbol+mode so concurrent calls
  -- serialize. Paper and live lock different rows and never block each other.
  select state, current_trade_id into v_state, v_trade_id
  from position_state
  where symbol = p_symbol and mode = p_mode
  for update;

  if not found then
    v_state := 'FLAT';
    v_trade_id := null;
    insert into position_state (symbol, mode, state, current_trade_id, updated_at)
    values (p_symbol, p_mode, 'FLAT', null, now())
    on conflict (symbol, mode) do nothing;
  end if;

  if v_state <> p_expected_state then
    return query select false, v_state, v_trade_id;
    return;
  end if;

  update position_state
  set state = p_new_state,
      current_trade_id = p_trade_id,
      updated_at = now()
  where symbol = p_symbol and mode = p_mode;

  return query select true, v_state, v_trade_id;
end;
$$ language plpgsql;
