'use strict';

const axios = require('axios');
const zlib = require('zlib');
const config = require('../config/env');
const logger = require('../utils/logger');

// Upstox's public instrument master — no auth required, refreshed by Upstox
// roughly daily. Confirmed reachable and containing NSE F&O contracts by
// direct testing (verified via scripts/find-instrument.js).
const INSTRUMENT_MASTER_URL = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz';

const SIGNAL_TO_OPTION_TYPE = { CALL_ENTRY: 'CE', PUT_ENTRY: 'PE' };

let cache = { instruments: null, fetchedAt: 0 };

/**
 * Downloads + caches the instrument master, filtered down to NSE F&O
 * CE/PE contracts (the only rows this bridge ever looks up), so the
 * in-memory cache stays small instead of holding all ~78k NSE instruments.
 * Cached for config.instrumentMasterCacheTtlMs; on a refresh failure with an
 * existing cache, serves the stale copy rather than failing every entry —
 * a few-hours-old contract list is still correct almost all the time,
 * whereas refusing every trade because of one transient fetch failure is a
 * worse outcome for a system whose whole point is placing entries reliably.
 */
async function loadInstrumentMaster() {
  const isStale = Date.now() - cache.fetchedAt > config.instrumentMasterCacheTtlMs;
  if (cache.instruments && !isStale) return cache.instruments;

  try {
    const res = await axios.get(INSTRUMENT_MASTER_URL, { responseType: 'arraybuffer', timeout: 15000 });
    const all = JSON.parse(zlib.gunzipSync(res.data).toString('utf8'));
    const filtered = all.filter((i) => i.segment === 'NSE_FO' && (i.instrument_type === 'CE' || i.instrument_type === 'PE'));
    cache = { instruments: filtered, fetchedAt: Date.now() };
    logger.info({ count: filtered.length }, 'Instrument master refreshed');
    return filtered;
  } catch (err) {
    if (cache.instruments) {
      logger.warn({ err: err.message }, 'Instrument master refresh failed — serving stale cache');
      return cache.instruments;
    }
    throw err;
  }
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

  return { instrumentToken: m.instrument_key, lotSize: m.lot_size, tradingSymbol: m.trading_symbol };
}

module.exports = { resolveEntryInstrument };
