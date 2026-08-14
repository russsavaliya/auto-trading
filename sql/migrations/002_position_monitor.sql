-- ============================================================================
-- Migration 002 — premium-based exit management
--
-- WHY
-- Exits were driven entirely by the Pine score, which is built from EMA /
-- Supertrend / MACD on the INDEX. Those are lagging measures: the option
-- premium peaks and fully round-trips long before the score decays enough to
-- fire an exit. Measured over 13-14 Aug 2026, 10 of 12 trades were in profit at
-- some point, the peaks were worth +Rs.7,247 in total, and Rs.11,064 was handed
-- back waiting for a score-based exit. The clearest case: trade 51 was up
-- Rs.1,656 twelve minutes in and closed at -Rs.18 sixty minutes in.
--
-- peak_premium lets the server trail a stop against the highest premium the
-- position has actually seen. It must be PERSISTED rather than held in memory:
-- a restart mid-position would otherwise reset the peak to the entry price and
-- silently disarm the trailing stop.
-- ============================================================================

alter table trades add column if not exists peak_premium numeric;

comment on column trades.peak_premium is
  'Highest option premium observed while this position was open. Drives the trailing stop in services/positionMonitor.js; persisted so a restart cannot disarm the trail.';

-- The monitor scans open positions every poll interval.
create index if not exists idx_trades_monitor
  on trades (status)
  where status = 'FILLED';
