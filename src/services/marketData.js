'use strict';

const axios = require('axios');
const config = require('../config/env');
const logger = require('../utils/logger');
const { istDate, istString } = require('../utils/marketClock');

/**
 * Real option premiums, used to price paper fills.
 *
 * WHY THIS IS NEEDED AT ALL
 * The Upstox SANDBOX never executes anything. Every order this bridge has ever
 * placed sits at status "open pending" with average_price 0 and
 * filled_quantity 0 — verified directly against /order/retrieve-all. So there
 * is no broker fill price to read back, and the old code's assumption that a
 * returned order_id meant "filled" was wrong.
 *
 * The sandbox host exposes no market-quote endpoints (404), and the live host
 * rejects a sandbox token (401). What DOES work, unauthenticated, on the live
 * host is the historical/intraday candle API — verified for both the index and
 * individual NSE_FO option contracts. So the honest paper fill is: mark the
 * position to the option's real traded price on the most recent completed
 * 1-minute candle, then apply a slippage allowance for the bid-ask you would
 * really have crossed.
 *
 * When this bridge is eventually pointed at the LIVE Upstox API, the broker's
 * own average_price becomes available and should win — see
 * upstoxService.getOrderFill() and the caller in routes/webhook.js.
 */

const LIVE_HOST = 'https://api.upstox.com';

// Candle responses are immutable once a minute has closed, so caching them is
// free correctness-wise and keeps a burst of signals from re-downloading the
// same day. Keyed by instrument+date; the entry for "today" is short-lived.
const cache = new Map();

// Today's candles must expire faster than the position monitor polls, or the
// stop-loss ends up acting on a stale quote. At the old 45s TTL against a 30s
// poll, roughly every other check re-used cached data — and stacked on top of
// the 1-minute candle granularity that put the price the stop reacted to as
// much as 105 seconds behind the market. 10s keeps the cache useful for bursts
// of signals without ever being the reason a stop fires late.
const TODAY_TTL_MS = 10 * 1000;

function cacheGet(key, isToday) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (isToday && Date.now() - hit.at > TODAY_TTL_MS) return null;
  return hit.candles;
}

async function fetchCandles(instrumentToken, dateStr, isToday) {
  const key = `${instrumentToken}|${dateStr}`;
  const cached = cacheGet(key, isToday);
  if (cached) return cached;

  const enc = encodeURIComponent(instrumentToken);
  const url = isToday
    ? `${LIVE_HOST}/v3/historical-candle/intraday/${enc}/minutes/1`
    : `${LIVE_HOST}/v3/historical-candle/${enc}/minutes/1/${dateStr}/${dateStr}`;

  const res = await axios.get(url, { timeout: 12000, headers: { Accept: 'application/json' } });
  // API returns newest-first; sort ascending so lookups can scan naturally.
  const candles = (res.data?.data?.candles || []).slice().sort((a, b) => new Date(a[0]) - new Date(b[0]));
  cache.set(key, { candles, at: Date.now() });
  return candles;
}

/**
 * Price of `instrumentToken` around `at`, as the 1-minute candle covering it.
 *
 * Returns both ends of that candle because the right one depends on why you
 * are asking:
 *   `close` — the most recent traded price. Correct for a LIVE order, where
 *             the covering candle is still forming and its close IS the last
 *             tick.
 *   `open`  — the price at the start of that minute. Correct for BACKFILL of a
 *             past order: taking `close` there would use a price from up to 60
 *             seconds AFTER the order was placed, which is look-ahead bias and
 *             would quietly flatter every historical result.
 *
 * Returns null (never throws) when there is no usable data — the caller
 * decides whether that is fatal, because an entry with no mark is a very
 * different problem from an exit with no mark.
 */
async function getPremiumAt(instrumentToken, at = Date.now()) {
  const dateStr = istDate(at);
  const isToday = dateStr === istDate();

  let candles;
  try {
    candles = await fetchCandles(instrumentToken, dateStr, isToday);
  } catch (err) {
    logger.warn({ err: err.message, instrumentToken, dateStr }, 'Premium lookup failed — no candle data');
    return null;
  }
  if (!candles.length) return null;

  // Most recent candle that had already closed at `at`. Falls back to the very
  // first candle of the day when `at` precedes the session (shouldn't happen
  // in normal flow, but a retry after a long stall could).
  let chosen = null;
  for (const c of candles) {
    if (new Date(c[0]).getTime() <= at) chosen = c;
    else break;
  }
  if (!chosen) chosen = candles[0];

  return {
    premium: Number(chosen[4]), // == close; kept as the default for live marks
    open: Number(chosen[1]),
    close: Number(chosen[4]),
    candleAt: chosen[0],
    volume: Number(chosen[5]),
  };
}

/**
 * The price a paper order should be recorded at. A BUY crosses the spread
 * upward and a SELL downward, by config.paperSlippagePoints — without this the
 * simulated book quietly assumes mid-price fills, which flatters every result
 * by roughly ₹90 per round trip at 30 quantity.
 */
async function getPaperFill({ instrumentToken, transactionType, at = Date.now() }) {
  const mark = await getPremiumAt(instrumentToken, at);
  if (!mark) return null;

  const slip = config.paperSlippagePoints;
  const signed = transactionType === 'BUY' ? mark.premium + slip : mark.premium - slip;
  const premium = Math.max(0.05, Number(signed.toFixed(2)));

  logger.info(
    { instrumentToken, transactionType, mark: mark.premium, slip, premium, candleAt: mark.candleAt, at: istString(at) },
    'Paper fill marked to real option premium'
  );
  return { premium, markPremium: mark.premium, candleAt: mark.candleAt, source: 'market_mark' };
}

module.exports = { getPremiumAt, getPaperFill };
