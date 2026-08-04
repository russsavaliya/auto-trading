'use strict';

// Looks up the exact Upstox instrument_token for an option contract by
// underlying + strike + CE/PE, using Upstox's public instrument master file
// (no auth needed — it's just contract metadata, refreshed daily by Upstox).
// Usage: node scripts/find-instrument.js BANKNIFTY 58000 CE

const axios = require('axios');
const zlib = require('zlib');

const INSTRUMENT_MASTER_URL = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz';

async function findInstrument(underlying, strike, optionType) {
  const res = await axios.get(INSTRUMENT_MASTER_URL, { responseType: 'arraybuffer' });
  const instruments = JSON.parse(zlib.gunzipSync(res.data).toString('utf8'));

  const matches = instruments.filter(
    (i) =>
      i.underlying_symbol === underlying &&
      i.instrument_type === optionType &&
      Number(i.strike_price) === Number(strike)
  );

  matches.sort((a, b) => a.expiry - b.expiry);
  return matches;
}

const [, , underlying, strike, optionType] = process.argv;

if (!underlying || !strike || !optionType) {
  console.log('Usage: node scripts/find-instrument.js <UNDERLYING> <STRIKE> <CE|PE>');
  console.log('Example: node scripts/find-instrument.js BANKNIFTY 58000 CE');
  process.exit(1);
}

findInstrument(underlying.toUpperCase(), strike, optionType.toUpperCase())
  .then((matches) => {
    if (matches.length === 0) {
      console.log('No matching contract found — check the strike price and underlying symbol.');
      return;
    }
    console.log(`Found ${matches.length} matching expiries (nearest first):\n`);
    matches.forEach((m) => {
      console.log(`  ${new Date(m.expiry).toISOString().slice(0, 10)}  ${m.trading_symbol}`);
      console.log(`    instrument_token: ${m.instrument_key}`);
      console.log(`    lot_size: ${m.lot_size}\n`);
    });
  })
  .catch((err) => {
    console.error('Failed to fetch/parse instrument master:', err.message);
    process.exit(1);
  });
