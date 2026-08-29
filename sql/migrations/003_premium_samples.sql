-- ============================================================================
-- Migration 003 — record the premium path of every open position
--
-- WHY
-- The position monitor already fetches the option's traded premium every
-- EXIT_POLL_SECONDS while a trade is open, but it throws the sample away after
-- comparing it to the exit rules. Only the running maximum survives, in
-- trades.peak_premium.
--
-- That makes it impossible to answer the one question that matters when tuning
-- an exit: "what would a different rule have done on this trade?" A rule needs
-- the PATH — when the position went up, how far it retraced, how long it sat —
-- and a single high-water mark cannot supply it.
--
-- The obvious fallback, re-downloading the option's candles from Upstox after
-- the fact, does not work: Upstox drops historical candles for expired option
-- contracts. Measured 29 Aug 2026 — of 75 trades taken since 6 Aug, only the 6
-- most recent could still be reconstructed. Everything older is gone forever.
-- The samples therefore have to be kept as they are taken; there is no second
-- chance at this data.
--
-- COST
-- One row per open position per poll: at a 30s poll and a 2-trade daily cap,
-- roughly 120 rows per position-hour, a few thousand rows a month. Trivial.
-- The write is fire-and-forget in the monitor — a failure here must never
-- interfere with a stop-loss.
-- ============================================================================

create table if not exists trade_premium_samples (
  id          bigserial primary key,
  trade_id    bigint not null references trades (id) on delete cascade,
  premium     numeric not null,          -- the option's traded price at this sample
  candle_at   timestamptz,               -- the 1-min candle the premium came from
  sampled_at  timestamptz not null default now()
);

comment on table trade_premium_samples is
  'Premium path of each position, one row per monitor poll. Written by services/positionMonitor.js. Exists because Upstox deletes candle history for expired option contracts, so this cannot be rebuilt after the fact — it is the only record of how a trade actually developed.';

comment on column trade_premium_samples.candle_at is
  'Timestamp of the 1-minute candle the premium was read from. Differs from sampled_at by up to a minute plus the poll interval; exit-rule replays must use THIS as the clock, not sampled_at.';

-- Every read of this table is "the whole path of one trade, in order".
create index if not exists idx_premium_samples_trade
  on trade_premium_samples (trade_id, sampled_at);
