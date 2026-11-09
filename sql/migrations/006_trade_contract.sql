-- ============================================================================
-- Migration 006 — record WHICH option contract every trade traded
--
-- WHY
-- The bridge picks the ATM contract itself (services/instrumentResolver.js),
-- but only its instrument_token was stored — and NSE hands a token to a
-- different contract once the old one expires. NSE_FO|69822 was BANKNIFTY
-- 57500 CE (September 2026) on trade 95; by November the same token was
-- ALKEM 5300 PE 25 JAN 27. So the strike, side and expiry must be written
-- down at entry: they cannot be looked up afterwards.
--
-- Additive and safe to run while the bridge is trading. Code deployed before
-- this migration keeps trading (it just records no contract); code deployed
-- after it records the contract from the next entry on.
-- ============================================================================

alter table trades add column if not exists trading_symbol text;
alter table trades add column if not exists strike_price numeric;
alter table trades add column if not exists option_type text;
alter table trades add column if not exists expiry date;
alter table trades add column if not exists lot_size integer;

do $$
begin
  alter table trades add constraint trades_option_type_check check (option_type in ('CE', 'PE'));
exception
  when duplicate_object then null;
end $$;

-- ----------------------------------------------------------------------------
-- Backfill the trades taken before this migration (6 Aug – 4 Sep 2026).
--
-- Derived, not guessed. Every entry since 4 Aug 2026 was auto-resolved as
-- strike = round(entry_spot / 100) * 100, CE for CALL / PE for PUT, nearest
-- expiry. Checked against the stored tokens: across 89 trades and 28 tokens no
-- token maps to two different derived contracts, and a contract changes token
-- only at the expiry roll — every trade before 26 Aug sits on the 59xxx series
-- (August contract, expiry 25 Aug 2026), every trade from 26 Aug on the
-- September contract (expiry 29 Sep 2026).
--
-- numeric round() rounds halves away from zero, as JS Math.round does for a
-- positive spot. Only rows still empty and taken before 5 Sep IST are touched,
-- so re-running this file changes nothing.
-- ----------------------------------------------------------------------------
update trades
set
  strike_price = round(entry_spot::numeric / 100) * 100,
  option_type  = case when signal_type like 'CALL%' then 'CE' else 'PE' end,
  expiry       = case when created_at < '2026-08-25T18:30:00Z' then date '2026-08-25'
                      else date '2026-09-29' end,
  lot_size     = 30
where strike_price is null
  and symbol = 'BANKNIFTY'
  and entry_spot is not null
  and created_at < '2026-09-04T18:30:00Z';

update trades
set trading_symbol = 'BANKNIFTY ' || strike_price::bigint || ' ' || option_type || ' '
                     || upper(to_char(expiry, 'DD Mon YY'))
where trading_symbol is null
  and strike_price is not null
  and expiry is not null
  and created_at < '2026-09-04T18:30:00Z';
