'use strict';

const axios = require('axios');
const zlib = require('zlib');
const config = require('../config/env');
const logger = require('../utils/logger');
const marketClock = require('../utils/marketClock');

// Upstox's public instrument master — no auth required, refreshed by Upstox
// roughly daily. Confirmed reachable and containing NSE F&O contracts by
// direct testing (verified via scripts/find-instrument.js).
const INSTRUMENT_MASTER_URL = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz';

const SIGNAL_TO_OPTION_TYPE = { CALL_ENTRY: 'CE', PUT_ENTRY: 'PE' };

let cache = { instruments: null, fetchedAt: 0 };

/**
 * Downloads + parses the instrument master, filtered down to NSE F&O CE/PE
 * contracts (the only rows this bridge ever looks up), and replaces the
 * cache. Called from warmUp() at boot and again on a recurring background
 * timer (see schedulePeriodicRefresh) — never from inside a webhook request,
 * so a live signal is never the one paying the ~2-5s download+parse cost.
 * On failure, the previous cache is left untouched (served stale rather
 * than emptied) — a few-hours-old contract list is still correct almost
 * all the time, whereas losing the cache on one transient fetch failure
 * would make every entry after it fail too.
 */
async function refresh() {
  const res = await axios.get(INSTRUMENT_MASTER_URL, { responseType: 'arraybuffer', timeout: 15000 });
  const all = JSON.parse(zlib.gunzipSync(res.data).toString('utf8'));
  const filtered = all.filter((i) => i.segment === 'NSE_FO' && (i.instrument_type === 'CE' || i.instrument_type === 'PE'));
  cache = { instruments: filtered, fetchedAt: Date.now() };
  logger.info({ count: filtered.length }, 'Instrument master refreshed');
  return filtered;
}

/**
 * Returns the cached instrument list. Freshness is entirely the background
 * timer's responsibility (see schedulePeriodicRefresh) — this never blocks
 * on a network call except as a last-resort bootstrap if a request somehow
 * arrives before the very first warm-up completed (should be rare/never in
 * practice, since warmUp() is awaited-in-spirit right at server boot).
 */
async function loadInstrumentMaster() {
  if (cache.instruments) return cache.instruments;
  logger.warn('Instrument master requested before warm-up completed — fetching inline this one time');
  return refresh();
}

/**
 * Resolves the exact Upstox instrument_token for the current-cycle,
 * at-the-money contract for a given underlying + signal direction + spot
 * price (the webhook's `price` field — already the underlying's price at
 * signal time, no extra market-data call needed). ATM strike = nearest
 * multiple of strikeInterval to spot. Picks the soonest expiry that hasn't
 * passed yet, so this naturally rolls to the next cycle once the current
 * one expires — no separate "rollover" step required.
 */
async function resolveEntryInstrument({ signalType, symbol, price }) {
  const optionType = SIGNAL_TO_OPTION_TYPE[signalType];
  if (!optionType) {
    throw new Error(`resolveEntryInstrument called with a non-entry signal_type: ${signalType}`);
  }

  const instruments = await loadInstrumentMaster();
  const atmStrike = Math.round(price / config.strikeInterval) * config.strikeInterval;
  const now = Date.now();

  const matches = instruments
    .filter(
      (i) =>
        i.underlying_symbol === symbol &&
        i.instrument_type === optionType &&
        Number(i.strike_price) === atmStrike &&
        i.expiry > now
    )
    .sort((a, b) => a.expiry - b.expiry);

  if (matches.length === 0) {
    throw new Error(`No unexpired ${optionType} contract found for ${symbol} at strike ${atmStrike} (spot=${price})`);
  }

  const m = matches[0];
  logger.info(
    { symbol, optionType, atmStrike, spot: price, tradingSymbol: m.trading_symbol, instrumentToken: m.instrument_key },
    'Resolved ATM instrument'
  );

  // The contract itself, not just its token: NSE reassigns a token to another
  // instrument after expiry, so this is the only moment the strike and expiry
  // can be recorded reliably. Upstox stamps expiry at 23:59:59 IST on the
  // expiry day, so its IST date is the expiry date.
  return {
    instrumentToken: m.instrument_key,
    lotSize: m.lot_size,
    tradingSymbol: m.trading_symbol,
    strikePrice: Number(m.strike_price),
    optionType: m.instrument_type,
    expiry: marketClock.istDate(m.expiry),
  };
}

/**
 * Keeps the cache from ever going stale during normal operation, entirely
 * in the background — a webhook request only ever reads whatever's already
 * cached (see loadInstrumentMaster), it never waits on this timer.
 * unref() so this recurring timer can't by itself keep the process alive.
 */
function schedulePeriodicRefresh() {
  const timer = setInterval(() => {
    refresh().catch((err) => logger.warn({ err: err.message }, 'Background instrument master refresh failed — keeping previous cache'));
  }, config.instrumentMasterCacheTtlMs);
  timer.unref();
}

/**
 * Called once at server startup: fetches immediately so the first real
 * webhook (or the next one after any restart/redeploy) doesn't pay the
 * download+parse cost inline, then starts the recurring background refresh
 * so the cache never goes stale for the rest of the process's lifetime.
 * Never throws — a failed initial fetch just means loadInstrumentMaster()
 * falls back to fetching inline on whichever request needs it first.
 */
function warmUp() {
  refresh()
    .then((instruments) => logger.info({ count: instruments.length }, 'Instrument master warm-up complete'))
    .catch((err) => logger.warn({ err: err.message }, 'Instrument master warm-up failed — will retry lazily on first entry'))
    .finally(() => schedulePeriodicRefresh());
}

module.exports = { resolveEntryInstrument, warmUp };
