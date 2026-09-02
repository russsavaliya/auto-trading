-- ============================================================================
-- Migration 004 — trade costs, and runtime config that does not need a deploy
--
-- WHY (part 1: charges)
-- Every P&L figure this system has ever produced is GROSS. On a BANKNIFTY
-- option round trip at 30 quantity and a ~600 premium the real friction is
-- roughly Rs.94 (brokerage, STT, exchange, SEBI, IPFT, GST, stamp duty, plus
-- this account's Rs.10/order API fee). Measured expectancy is already around
-- -Rs.155/trade, so costs are not a rounding error — they are a large part of
-- the answer, and a +Rs.60 "winner" is really a loss.
--
-- The charge is STORED, not computed at read time, because statutory rates
-- change (STT on option sales went 0.0625% -> 0.1% in Oct 2024). A trade must
-- keep the cost that applied on the day it was closed; recomputing history
-- with today's rates would silently rewrite past results every time a rate
-- moves. services/charges.js owns the arithmetic and is the only place rates
-- live.
--
-- charges_breakdown keeps the component split (jsonb) so the Report page can
-- show WHERE the money went without re-deriving it, and so a future rate
-- change is auditable against what was actually charged.
--
-- WHY (part 2: runtime config)
-- max_trades_per_day and the re-entry cooldown were env vars. On Render an env
-- change is a redeploy, which means the daily cap could not be adjusted from
-- the dashboard while the market was open — exactly when you would want to.
-- Moving them beside trading_enabled makes them settable from the Settings
-- page, and the app keeps the env value as a fallback for when the row cannot
-- be read (see services/supabaseService.js).
--
-- Defaults below deliberately match the current env defaults, so applying this
-- migration changes NO behaviour until someone edits a value.
--
-- Safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Per-trade costs
-- ---------------------------------------------------------------------------
alter table trades add column if not exists charges           numeric;
alter table trades add column if not exists charges_breakdown jsonb;

comment on column trades.charges is
  'Total round-trip cost in rupees, as computed by services/charges.js at the moment the trade closed. NULL means either an unpriced leg or a trade closed before migration 004 — backfill with scripts/backfill-charges.js.';
comment on column trades.charges_breakdown is
  'Component split of trades.charges: brokerage, apiFee, stt, exchangeTxn, sebi, ipft, gst, stampDuty, plus buy/sell turnover.';

-- ---------------------------------------------------------------------------
-- Runtime config
-- ---------------------------------------------------------------------------
alter table app_config add column if not exists max_trades_per_day        smallint not null default 2;
alter table app_config add column if not exists re_entry_cooldown_enabled boolean  not null default true;
alter table app_config add column if not exists re_entry_cooldown_minutes smallint not null default 15;

comment on column app_config.max_trades_per_day is
  'Entries allowed per symbol per IST day. 0 disables the cap entirely. Rationale for the default of 2 is in src/config/env.js.';
comment on column app_config.re_entry_cooldown_enabled is
  'When true, a stop_loss / trailing_stop / time_stop exit blocks a SAME-DIRECTION re-entry for re_entry_cooldown_minutes. Not P&L based: a profitable trailing-stop exit blocks exactly the same as a losing one. A reversal to the other side is always allowed.';
comment on column app_config.re_entry_cooldown_minutes is
  'Cooldown length in minutes. Ignored when re_entry_cooldown_enabled is false.';

-- Keep the singleton sane if it somehow predates the defaults above.
update app_config
   set max_trades_per_day        = coalesce(max_trades_per_day, 2),
       re_entry_cooldown_enabled = coalesce(re_entry_cooldown_enabled, true),
       re_entry_cooldown_minutes = coalesce(re_entry_cooldown_minutes, 15)
 where id = 1;
