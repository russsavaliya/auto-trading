-- ============================================================================
-- Migration 001 — premium-based accounting
--
-- WHY THIS EXISTS
-- The bridge used to write the BANK NIFTY INDEX level into trades.entry_price
-- / exit_price (that is what the Pine `price` field carries) and then compute
--     pnl = (price - entry_price) * quantity
-- Those are index points, not option premium. For CALL trades that gets the
-- sign right by luck; for PUT trades it is exactly inverted — the index falls,
-- the put gains, and the row records a loss. Measured over 6-12 Aug 2026 the
-- summary endpoint reported +1533 while the true result was -3934, and 7 of
-- 24 closed trades carried the wrong sign.
--
-- After this migration:
--   entry_spot / exit_spot     -> the underlying index level (what used to sit
--                                 in entry_price / exit_price)
--   entry_price / exit_price   -> the OPTION PREMIUM per unit actually paid /
--                                 received. This is what pnl is computed from.
--   *_fill_source              -> where that premium came from, so a broker
--                                 fill is never silently confused with a mark.
--   broker_*_status            -> what Upstox actually said, kept separate from
--                                 our own lifecycle `status` column.
--
-- Safe to re-run.
-- ============================================================================

alter table trades add column if not exists entry_spot          numeric;
alter table trades add column if not exists exit_spot           numeric;
alter table trades add column if not exists entry_fill_source   text;
alter table trades add column if not exists exit_fill_source    text;
alter table trades add column if not exists broker_entry_status text;
alter table trades add column if not exists broker_exit_status  text;
alter table trades add column if not exists closed_reason       text;

-- ----------------------------------------------------------------------------
-- Move the legacy index levels into the columns that actually mean "index",
-- then clear the price columns so nothing downstream keeps reading an index
-- level as if it were a premium. scripts/backfill-premiums.js repopulates
-- entry_price/exit_price/pnl from Upstox historical candles.
-- Guarded by entry_spot being null so re-running cannot double-migrate.
-- ----------------------------------------------------------------------------
update trades
set entry_spot = entry_price,
    exit_spot  = exit_price,
    entry_price = null,
    exit_price  = null,
    pnl         = null,
    entry_fill_source = 'legacy_unbackfilled',
    exit_fill_source  = case when exit_price is not null then 'legacy_unbackfilled' else null end
where entry_spot is null
  and entry_price is not null;

comment on column trades.entry_price is 'Option premium per unit paid on entry. NOT the index level — see entry_spot.';
comment on column trades.exit_price  is 'Option premium per unit received on exit. NOT the index level — see exit_spot.';
comment on column trades.entry_spot  is 'Underlying index level at entry signal time.';
comment on column trades.exit_spot   is 'Underlying index level at exit signal time.';
comment on column trades.pnl         is '(exit_price - entry_price) * quantity, in rupees, from PREMIUM.';
comment on column trades.entry_fill_source is 'broker_fill | market_mark | legacy_unbackfilled — provenance of entry_price.';

-- ----------------------------------------------------------------------------
-- The square-off scheduler needs to find positions that are open past the
-- cutoff without scanning the whole table.
-- ----------------------------------------------------------------------------
create index if not exists idx_trades_open_positions
  on trades (status, created_at desc)
  where status in ('PENDING', 'FILLED');

-- ----------------------------------------------------------------------------
-- Kill-switch table gains a second, narrower switch: pause NEW entries while
-- still allowing exits to go through. Flipping trading_enabled off strands
-- open positions, which is exactly what you do not want mid-session.
-- ----------------------------------------------------------------------------
alter table app_config add column if not exists entries_enabled boolean not null default true;

comment on column app_config.trading_enabled is 'Master kill switch. false = no orders at all, including exits.';
comment on column app_config.entries_enabled is 'false = refuse new entries but still allow exits/square-off. Use this to wind down safely.';
