'use strict';

/**
 * Replays the strategy over days when TradingView sent nothing, against real
 * market data, and — with --apply — records the result as PAPER trades.
 *
 * WHY
 * When the TradingView subscription lapses, Pine stops firing and the bridge
 * sits idle, so the paper record simply has a hole in it. But the strategy is
 * fully determined by public data: the score is built from BANKNIFTY 5-minute
 * candles, and every paper fill is already marked to the traded option's real
 * 1-minute candles. So the hole can be filled honestly, by running the same
 * rules over the same data the live path would have used.
 *
 * WHAT IS REPLAYED, IN ORDER
 *   1. strategy/pineScript.js, bar for bar on Upstox 5-minute candles: entries
 *      gated on FLAT, exits once |score| <= 3 or the bias flips, the one-bar
 *      cooldown, the 14:45 entry cutoff and the 15:15 force exit. Re-asserts
 *      are off by default — see PINE below for the evidence.
 *   2. The bridge, alert by alert in arrival order: daily cap, same-side
 *      re-entry cooldown after a risk-rule exit, FLAT-only entries, ATM
 *      contract resolution, and the premium exit rules — run through
 *      positionMonitor.evaluate() itself, not a copy of it.
 *   3. Fills the way the live paper path marks them: the option's traded price
 *      at the moment the order would have gone in, PAPER_SLIPPAGE_POINTS
 *      against you on each leg, and charges.js for costs.
 *
 * EXPIRED CONTRACTS ARE MODELLED, AND LABELLED AS SUCH
 * Upstox deletes candle history for expired option contracts ("Invalid
 * Instrument key"). For a day whose front-month contract has since expired,
 * the premium is priced with Black-76 on the real index path, with the
 * forward from that day's futures basis and volatility = India VIX (real,
 * minute by minute) x a factor fitted to the expired contract's OWN four real
 * prints of the day — open, high, low, last — from the NSE bhavcopy. So every
 * modelled day is pinned to the range that contract really traded in. Those
 * trades carry fill source backfilled_replay_model; real-candle trades carry
 * backfilled_replay. --validate-model measures the model against trades whose
 * real premium path was recorded.
 *
 * (The next-month contract looks like the natural volatility source and is
 * not: on 26 Aug 2026 the Oct 57800 CE traded 480 units all day and the 57800
 * PE did not trade at all on the 27th. It only becomes liquid in the last
 * week of the cycle.)
 *
 * HONEST LIMITS — read before trusting a rupee of the output
 *   - Upstox and TradingView 5-minute bars are not identical and the score is
 *     a stack of threshold comparisons, so a signal can land a bar early or
 *     late. Measured over 20 Aug - 4 Sep 2026: 98 of 107 real alerts land on
 *     the same bar (--validate).
 *   - The monitor is replayed on 1-minute closes. Live polls every 30s on the
 *     forming candle, so a stop can fire a little earlier or later live.
 *
 * Usage
 *   node scripts/replay-signals.js                                 # dry run: day after the last real alert -> today
 *   node scripts/replay-signals.js --from 2026-09-30 --to 2026-10-07
 *   node scripts/replay-signals.js --apply                         # write the result as paper trades
 *   node scripts/replay-signals.js --undo --from 2026-09-07        # list replay rows in the window
 *   node scripts/replay-signals.js --undo --from 2026-09-07 --apply   # delete exactly those rows
 *   node scripts/replay-signals.js --validate --from 2026-08-20 --to 2026-09-04
 *                                       # replica signals vs alerts TradingView really sent
 *   node scripts/replay-signals.js --validate-model --from 2026-08-26 --to 2026-09-04
 *                                       # premium model + bridge vs trades that really happened
 *   --reassert                          # what-if: re-send entries every 3 bars, as the script default does
 */

require('dotenv').config();

const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const config = require('../src/config/env');
const charges = require('../src/services/charges');
const { evaluate } = require('../src/services/positionMonitor');
const { supabase } = require('../src/services/supabaseService');
const mc = require('../src/utils/marketClock');
const { ema, rsi, macd, supertrend } = require('../research/indicators');

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------
const argValue = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

const APPLY = hasFlag('apply');
const UNDO = hasFlag('undo');
const VALIDATE = hasFlag('validate');
const VALIDATE_MODEL = hasFlag('validate-model');
const OFFLINE = hasFlag('offline');
const WARMUP_DAYS = Number(argValue('warmup-days') || 45);

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------
const SYMBOL = 'BANKNIFTY';
const INDEX_KEY = 'NSE_INDEX|Nifty Bank';
const VIX_KEY = 'NSE_INDEX|India VIX';
const MODE = 'paper'; // this tool never reads or writes any other mode
// Both start with "backfilled" so the dashboard flags these rows the way it
// already flags repaired trades — a replayed premium is a mark, never a fill.
const FILL_MARK = 'backfilled_replay'; // the traded option's real 1-minute candles
const FILL_MODEL = 'backfilled_replay_model'; // expired contract, priced by modelFeed()
const isReplayFill = (s) => typeof s === 'string' && s.startsWith(FILL_MARK);
const BROKER_STATUS = 'replay_no_order';
const ALERT_PREFIX = 'replay-';
// Bar close -> webhook arrival. Measured on the 20 Aug - 4 Sep alerts: 3-17s,
// median about 5s.
const ALERT_LATENCY_MS = 5000;
const MIN = 60 * 1000;
// Expected wait from "maxHold elapsed" to the monitor poll that acts on it.
const TIME_STOP_POLL_LAG_MS = (config.exitPollSeconds * 1000) / 2;
const RULE_EXITS = new Set(['stop_loss', 'trailing_stop', 'time_stop']);
const API = 'https://api.upstox.com/v3/historical-candle';
const MASTER_URL = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz';
const BHAV_URL = (date) =>
  `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_${date.replace(/-/g, '')}_F_0000.csv.zip`;
const CACHE_DIR = path.join(os.tmpdir(), 'upstox-replay-cache');
const CHUNK_DAYS = 25; // Upstox rejects minute-candle ranges much past a month
const DB_TIMEOUT_MS = 20000;
// A modelled day is trusted only if it reproduces the expired contract's real
// high, low and close to within this (log) distance. The open is left out of
// the test — it is an auction print and routinely off on its own. A day that
// fails keeps its best-estimate timeline but is written UNPRICED.
const MODEL_MAX_MISS = 0.15;
const SESSION_MIN = 375; // 09:15-15:30
const TRADING_YEAR_MIN = 252 * SESSION_MIN;
const RISK_FREE = 0.06;

/**
 * strategy/pineScript.js inputs as they were actually set on the chart. Change
 * these only together with that file — or the chart.
 *
 * reassertEntries is the one deliberate departure from the file's default.
 * The script defaults it ON, but across 107 real alerts from the current
 * version (20 Aug - 4 Sep 2026) TradingView sent not a single re-assert, while
 * the replica with it on produced 118 extra alerts — almost all of them
 * re-asserts. The chart was evidently running with it switched off, and a
 * replay of what TradingView would have sent has to follow the chart.
 * --reassert turns it back on for a what-if.
 */
const PINE = {
  emaFast: 9,
  emaSlow: 21,
  rsiLen: 14,
  stFactor: 2.0,
  stAtr: 10,
  entryThreshold: 4,
  exitThreshold: 3,
  confirmBars: 1,
  cooldownBars: 1,
  reassertEntries: hasFlag('reassert'),
  reassertBars: 3,
  erLength: 10,
  minEfficiencyRatio: 0,
  entryCutoff: 14 * 60 + 45,
  squareOff: 15 * 60 + 15,
  barMinutes: 5,
  orderQty: 30,
};

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tsOf = (c) => new Date(c[0]).getTime();
const iso = (ms) => new Date(ms).toISOString();
const hhmm = (ms) => mc.istTime(ms);
const addDays = (d, n) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const minuteOfDay = (ms) => {
  const t = mc.istTime(ms);
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
};
const money = (n) => (n == null ? '       —' : `${n < 0 ? '-' : '+'}Rs.${Math.abs(n).toFixed(0)}`.padStart(9));
const dbq = (query) => query.abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
/** '2026-09-29' -> '29 SEP 26', the instrument master's trading_symbol style. */
const expiryLabel = (d) => `${d.slice(8, 10)} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(2, 4)}`;
/** The instrument master stamps an expiry as 23:59:59 IST of the day. */
const expiryEndMs = (d) => mc.istToEpoch(d, '23:59') + 59 * 1000;

// ----------------------------------------------------------------------------
// Market data
// ----------------------------------------------------------------------------
async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await axios.get(url, { timeout: 30000, headers: { Accept: 'application/json' } });
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      if (attempt >= 4 || (status && status !== 429 && status < 500)) {
        const detail = err.response?.data?.errors?.[0]?.message || err.message;
        throw new Error(`Upstox ${status || 'network error'}: ${detail} (${url})`);
      }
      await sleep(600 * 2 ** attempt);
    }
  }
}

/** One historical range. Past ranges never change, so they are cached on disk. */
async function fetchRange(key, interval, from, to) {
  const cacheable = to < mc.istDate();
  const file = path.join(CACHE_DIR, `${key}_m${interval}_${from}_${to}.json`.replace(/[^\w.-]+/g, '_'));
  if (cacheable && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));

  // v3 orders the path .../{interval}/{TO_DATE}/{FROM_DATE} — see replicate-indicator.js.
  const body = await getJson(`${API}/${encodeURIComponent(key)}/minutes/${interval}/${to}/${from}`);
  const candles = body?.data?.candles || [];
  if (cacheable) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(candles));
  }
  return candles;
}

/** Minute candles for the IST dates [from, to], ascending. Today comes from the intraday endpoint. */
async function loadCandles(key, interval, from, to) {
  const today = mc.istDate();
  const byTime = new Map();
  const histTo = to < today ? to : addDays(today, -1);

  let start = from;
  while (start <= histTo) {
    const chunkEnd = addDays(start, CHUNK_DAYS - 1);
    const end = chunkEnd < histTo ? chunkEnd : histTo;
    for (const c of await fetchRange(key, interval, start, end)) byTime.set(tsOf(c), c);
    start = addDays(end, 1);
  }
  if (to >= today) {
    const body = await getJson(`${API}/intraday/${encodeURIComponent(key)}/minutes/${interval}`);
    for (const c of body?.data?.candles || []) byTime.set(tsOf(c), c);
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
}

async function loadContracts() {
  const res = await axios.get(MASTER_URL, { responseType: 'arraybuffer', timeout: 30000 });
  return JSON.parse(zlib.gunzipSync(res.data).toString('utf8')).filter(
    (i) => i.segment === 'NSE_FO' && i.underlying_symbol === SYMBOL && (i.instrument_type === 'CE' || i.instrument_type === 'PE')
  );
}

/** One instrument's 1-minute candles for one IST day, indexed by minute. */
const feeds = new Map();
async function dayFeed(key, date) {
  const id = `${key}|${date}`;
  if (!feeds.has(id)) {
    const candles = await loadCandles(key, 1, date, date);
    feeds.set(id, { candles, byMinute: new Map(candles.map((c) => [tsOf(c), c])) });
  }
  return feeds.get(id);
}

/**
 * Last traded price at `t`, from 1-minute candles.
 *
 * A webhook lands a few seconds into a minute, so the price then is that
 * minute's OPEN — its close would be up to 55s of look-ahead, the same trap
 * backfill-premiums.js documents. A monitor sample is taken at the END of a
 * minute, so its price is that minute's CLOSE. A minute with no trade falls
 * back to the last print before it.
 */
function ltp(feed, t) {
  const minute = Math.floor(t / MIN) * MIN;
  const c = feed.byMinute.get(minute);
  if (c) return t - minute >= MIN / 2 ? Number(c[4]) : Number(c[1]);
  let last = null;
  for (const x of feed.candles) {
    if (tsOf(x) < minute) last = x;
    else break;
  }
  return last ? Number(last[4]) : null;
}

// ----------------------------------------------------------------------------
// NSE bhavcopy — the one public record of an expired contract's prices
// ----------------------------------------------------------------------------

/** The single entry of a .zip, without a dependency: central directory -> local header -> inflate. */
function unzipSingle(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const cd = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('zip central directory not found');
  const method = buf.readUInt16LE(cd + 10);
  const size = buf.readUInt32LE(cd + 20);
  const local = buf.readUInt32LE(cd + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + size);
  return method === 0 ? data : zlib.inflateRawSync(data);
}

const bhavCache = new Map();
async function bhavcopy(date) {
  if (bhavCache.has(date)) return bhavCache.get(date);
  const file = path.join(CACHE_DIR, `bhav_fo_${date}.csv`);
  let csv;
  if (fs.existsSync(file)) {
    csv = fs.readFileSync(file, 'utf8');
  } else {
    let res;
    try {
      res = await axios.get(BHAV_URL(date), {
        responseType: 'arraybuffer',
        timeout: 60000,
        // nsearchives refuses requests that do not look like a browser.
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          Referer: 'https://www.nseindia.com/',
          Accept: '*/*',
        },
      });
    } catch (err) {
      throw new Error(`NSE bhavcopy ${date}: ${err.response?.status || err.message}`);
    }
    csv = unzipSingle(Buffer.from(res.data)).toString('utf8');
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, csv);
  }

  const lines = csv.trim().split(/\r?\n/);
  const col = Object.fromEntries(lines[0].split(',').map((h, i) => [h.trim(), i]));
  const options = [];
  const futures = new Map();
  let underlying = null;
  for (const line of lines.slice(1)) {
    const f = line.split(',');
    if (f[col.TckrSymb] !== SYMBOL) continue;
    if (f[col.FinInstrmTp] === 'IDF') futures.set(f[col.XpryDt], Number(f[col.ClsPric]));
    if (f[col.FinInstrmTp] !== 'IDO') continue;
    underlying = Number(f[col.UndrlygPric]);
    options.push({
      token: f[col.FinInstrmId],
      expiry: f[col.XpryDt],
      strike: Number(f[col.StrkPric]),
      type: f[col.OptnTp],
      open: Number(f[col.OpnPric]),
      high: Number(f[col.HghPric]),
      low: Number(f[col.LwPric]),
      // NSE's closing price for a contract is the weighted average of its
      // last half hour, not the last trade (on expiry day the 54400 CE shows
      // close 25.10 against a last trade of 0.05).
      close: Number(f[col.ClsPric]),
    });
  }
  const parsed = { options, futures, underlying };
  bhavCache.set(date, parsed);
  return parsed;
}

// ----------------------------------------------------------------------------
// Black-76 — European index options on the forward
// ----------------------------------------------------------------------------
function normCdf(x) {
  // Abramowitz & Stegun 7.1.26 via erf; |error| < 1.5e-7, far below a 0.05 tick.
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + (x < 0 ? -erf : erf));
}

function black76(type, F, K, T, sigma) {
  const df = Math.exp(-RISK_FREE * Math.max(T, 0));
  if (T <= 0 || sigma <= 0) return df * Math.max(type === 'CE' ? F - K : K - F, 0);
  const v = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * v * v) / v;
  const d2 = d1 - v;
  return type === 'CE' ? df * (F * normCdf(d1) - K * normCdf(d2)) : df * (K * normCdf(-d2) - F * normCdf(-d1));
}

/** Minimum of a unimodal f on [a, b]. */
function goldenSection(f, a, b, iterations = 60) {
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  let fc = f(c);
  let fd = f(d);
  for (let i = 0; i < iterations; i++) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - g * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + g * (b - a);
      fd = f(d);
    }
  }
  return (a + b) / 2;
}

const toTick = (p) => Math.max(0.05, Math.round(p * 20) / 20);

/**
 * Time to expiry in TRADING time — session minutes left, as a fraction of a
 * 252-session year.
 *
 * Calendar time looks equivalent and is badly wrong at the end of a cycle:
 * on expiry morning it counts 6.25 hours as 6.25/8760 of a year, so the model
 * needed VIX x 4.4 to reproduce the real 29 Sep 2026 prices, and VIX x 1.75
 * the day before (a Monday, with the weekend inside the calendar clock). The
 * market prices what is left to TRADE. Holidays are ignored — one missing
 * session in a month moves sqrt(T) by under 2%, and the fitted level absorbs it.
 */
function tradingYears(expiryDate, t) {
  const today = mc.istDate(t);
  if (today > expiryDate) return 0;
  const nowMin = minuteOfDay(t) + (t % MIN) / MIN;
  const leftToday = Math.max(0, Math.min(SESSION_MIN, 15 * 60 + 30 - nowMin));
  let sessions = 0;
  for (let d = addDays(today, 1); d <= expiryDate; d = addDays(d, 1)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) sessions++;
  }
  return (leftToday + sessions * SESSION_MIN) / TRADING_YEAR_MIN;
}

/**
 * A synthetic 1-minute feed for a contract Upstox no longer serves.
 *
 * Every input is a real print; only the output is modelled:
 *   - the index path — Upstox 1-minute candles,
 *   - intraday volatility moves — India VIX, 1-minute,
 *   - the forward — that day's futures close over the index close,
 *   - the volatility LEVEL — a factor on VIX fitted so the model reproduces
 *     the expired contract's own open, high, low and last prints from the NSE
 *     bhavcopy. High and low are matched against the index's favourable and
 *     adverse extreme of each minute, so the fit has to reproduce the range
 *     the contract really traded in, not just two points of it.
 */
async function modelFeed(c, date) {
  const id = `model|${c.instrumentToken}|${date}`;
  if (feeds.has(id)) return feeds.get(id);

  const [bhav, index, vix] = await Promise.all([bhavcopy(date), dayFeed(INDEX_KEY, date), dayFeed(VIX_KEY, date)]);
  const row = bhav.options.find((o) => `NSE_FO|${o.token}` === c.instrumentToken);
  if (!row || !index.candles.length || !vix.candles.length) {
    const missing = !row ? 'its bhavcopy row' : !index.candles.length ? 'index candles' : 'India VIX candles';
    throw new Error(`cannot model ${c.tradingSymbol} on ${date}: missing ${missing}`);
  }

  const forward = bhav.futures.get(c.expiry) && bhav.underlying ? bhav.futures.get(c.expiry) / bhav.underlying : 1;
  const closeAt = mc.istToEpoch(date, '15:29') + MIN - 1;
  const minutes = index.candles.filter((x) => tsOf(x) <= closeAt);
  // The fit never looks at the session's final index candle. Upstox stamps
  // NSE's official close into it, and that can be nowhere near the last trade:
  // on 31 Aug 2026 the feed sat frozen at 57397.35 from 15:16 and the 15:29
  // candle then "closed" at 58024.95, while that minute's option prices put
  // the index near 57520 by put-call parity.
  const fitMinutes = minutes.slice(0, -1);
  const lastHalfHour = fitMinutes.filter((x) => minuteOfDay(tsOf(x)) >= 15 * 60);
  const price = (spot, t, vol) => black76(c.type, spot * forward, c.strike, tradingYears(c.expiry, t), vol);

  // VIX as a fraction, per index minute. Each minute uses its CLOSE: the
  // day's first print comes out of the opening auction and routinely sits a
  // full point away from where VIX settles a minute later.
  let carried = null;
  const vixAt = minutes.map((ic) => {
    const v = vix.byMinute.get(tsOf(ic));
    if (v) carried = Number(v[4]) / 100;
    return carried;
  });
  const firstVix = vixAt.find((v) => v != null);
  for (let i = 0; i < vixAt.length && vixAt[i] == null; i++) vixAt[i] = firstVix;

  const favourable = (ic) => Number(c.type === 'CE' ? ic[2] : ic[3]);
  const adverse = (ic) => Number(c.type === 'CE' ? ic[3] : ic[2]);
  const modelled = (kappa) => {
    let high = -Infinity;
    let low = Infinity;
    fitMinutes.forEach((ic, i) => {
      const t = tsOf(ic) + MIN / 2;
      high = Math.max(high, price(favourable(ic), t, vixAt[i] * kappa));
      low = Math.min(low, price(adverse(ic), t, vixAt[i] * kappa));
    });
    // Same construction as NSE's close: the average over the last half hour.
    const closes = lastHalfHour.map((ic) => {
      const i = minutes.indexOf(ic);
      return price(Number(ic[4]), tsOf(ic) + MIN - 1, vixAt[i] * kappa);
    });
    return {
      open: price(Number(minutes[0][1]), tsOf(minutes[0]), vixAt[0] * kappa),
      high,
      low,
      close: closes.length ? closes.reduce((s, x) => s + x, 0) / closes.length : NaN,
    };
  };

  // The opening print is the least trustworthy of the four (auction, wide
  // quotes), so it counts half.
  const targets = [
    ['open', row.open, 0.5],
    ['high', row.high, 1],
    ['low', row.low, 1],
    ['close', row.close, 1],
  ].filter(([k, v]) => v > 0 && (k !== 'close' || lastHalfHour.length));
  const loss = (kappa) => {
    const m = modelled(kappa);
    return targets.reduce((s, [k, v, w]) => s + w * Math.log(Math.max(m[k], 0.05) / v) ** 2, 0);
  };
  const kappa = goldenSection(loss, 0.2, 5);
  const fitted = modelled(kappa);

  const candles = minutes.map((ic, i) => {
    const m = tsOf(ic);
    const vol = vixAt[i] * kappa;
    const o = toTick(price(Number(ic[1]), m, (i > 0 ? vixAt[i - 1] : vixAt[0]) * kappa));
    const cl = toTick(price(Number(ic[4]), m + MIN - 1, vol));
    const h = toTick(price(favourable(ic), m + MIN / 2, vol));
    const l = toTick(price(adverse(ic), m + MIN / 2, vol));
    return [iso(m), o, Math.max(o, cl, h), Math.min(o, cl, l), cl];
  });

  const fit = Object.fromEntries(targets.map(([k, v]) => [k, { real: v, model: toTick(fitted[k]) }]));
  const worstMiss = Math.max(
    0,
    ...Object.entries(fit)
      .filter(([k]) => k !== 'open')
      .map(([, v]) => Math.abs(Math.log(v.model / v.real)))
  );
  // Expiry day is never trusted, however the fit looks: with hours left the
  // price is all gamma and pinning, which one volatility number cannot carry.
  const expiryDay = date === c.expiry;

  const feed = {
    candles,
    byMinute: new Map(candles.map((x) => [tsOf(x), x])),
    model: {
      kappa,
      vol: firstVix * kappa,
      fit,
      worstMiss,
      confident: !expiryDay && worstMiss <= MODEL_MAX_MISS,
      why: expiryDay ? 'expiry day' : worstMiss > MODEL_MAX_MISS ? `misses a real print by ${(worstMiss * 100).toFixed(0)}%` : null,
    },
  };
  feeds.set(id, feed);
  return feed;
}

// ----------------------------------------------------------------------------
// Contract resolution — instrumentResolver.js, plus the one thing it never had
// to know: whether the contract it would have picked still exists.
// ----------------------------------------------------------------------------
function lastTuesdayOf(year, month) {
  const d = new Date(Date.UTC(year, month, 0)); // last day of `month` (1-12)
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * When the contract cycle BEFORE the earliest listed one expired. BANKNIFTY is
 * monthly-only and expires on the last Tuesday, moved back to the previous
 * session on a holiday (Nov 2026 expires Monday the 23rd for that reason).
 * Anything placed on or before this moment traded a contract the instrument
 * master no longer lists and Upstox no longer serves candles for.
 */
function expiredCycleEnd(contracts, tradingDays) {
  const firstDate = mc.istDate(Math.min(...contracts.map((c) => c.expiry)));
  let y = Number(firstDate.slice(0, 4));
  let m = Number(firstDate.slice(5, 7)) - 1;
  if (m === 0) {
    m = 12;
    y -= 1;
  }
  let d = lastTuesdayOf(y, m);
  // Only a day inside the loaded candles can be shown to be a holiday; past
  // their end, absence of data proves nothing.
  const lastKnown = [...tradingDays].sort().pop();
  for (let guard = 0; guard < 7 && d <= lastKnown && !tradingDays.has(d); guard++) d = addDays(d, -1);
  return { date: d, endMs: expiryEndMs(d) };
}

function makeResolver(contracts, expired) {
  return async function resolve({ signalType, price, at }) {
    const type = signalType.startsWith('CALL') ? 'CE' : 'PE';
    const strike = Math.round(price / config.strikeInterval) * config.strikeInterval;

    if (at > expired.endMs) {
      const match = contracts
        .filter((i) => i.instrument_type === type && Number(i.strike_price) === strike && i.expiry > at)
        .sort((a, b) => a.expiry - b.expiry)[0];
      if (!match) return { error: `No unexpired ${type} contract found for ${SYMBOL} at strike ${strike} (spot=${price})` };
      return { instrumentToken: match.instrument_key, tradingSymbol: match.trading_symbol, strike, type, model: false };
    }

    // That cycle has expired since. The contract the bridge would have picked
    // comes from the day's bhavcopy — its FinInstrmId IS the Upstox NSE_FO key
    // (verified: BANKNIFTY26SEP57500CE = 69822 = trade 95's instrument_token).
    const date = mc.istDate(at);
    const bhav = await bhavcopy(date);
    const front = bhav.options
      .filter((o) => o.type === type && o.strike === strike && expiryEndMs(o.expiry) > at)
      .sort((a, b) => (a.expiry < b.expiry ? -1 : 1))[0];
    if (!front) return { error: `No ${type} contract at strike ${strike} in the ${date} bhavcopy (spot=${price})` };
    return {
      instrumentToken: `NSE_FO|${front.token}`,
      tradingSymbol: `${SYMBOL} ${strike} ${type} ${expiryLabel(front.expiry)}`,
      strike,
      type,
      model: true,
      expiry: front.expiry,
    };
  };
}

// ----------------------------------------------------------------------------
// 1. Pine — score and state machine, bar for bar
// ----------------------------------------------------------------------------
function buildScore(bars) {
  const close = bars.map((b) => Number(b[4]));
  const high = bars.map((b) => Number(b[2]));
  const low = bars.map((b) => Number(b[3]));
  const eF = ema(close, PINE.emaFast);
  const eS = ema(close, PINE.emaSlow);
  const r = rsi(close, PINE.rsiLen);
  const m = macd(close);
  const stDir = supertrend(high, low, close, PINE.stFactor, PINE.stAtr);

  const score = [];
  const er = [];
  for (let i = 0; i < bars.length; i++) {
    if ([eF[i], eS[i], r[i], m.line[i], m.signal[i], stDir[i]].some((v) => v == null)) {
      score.push(null);
    } else {
      let trend = 0;
      trend += eF[i] > eS[i] ? 1 : -1;
      trend += close[i] > eS[i] ? 1 : -1;
      trend += stDir[i] < 0 ? 1 : -1; // supertrend green
      let mom = 0;
      mom += r[i] > 55 ? 1 : r[i] < 45 ? -1 : 0;
      mom += m.line[i] > m.signal[i] ? 1 : -1;
      score.push(trend + mom); // volume component is off by default in Pine
    }

    if (i < PINE.erLength) {
      er.push(0); // Pine: erPath is na -> efficiencyRatio 0.0
    } else {
      let travelled = 0;
      for (let k = i - PINE.erLength + 1; k <= i; k++) travelled += Math.abs(close[k] - close[k - 1]);
      er.push(travelled > 0 ? Math.abs(close[i] - close[i - PINE.erLength]) / travelled : 0);
    }
  }
  return { score, er, close };
}

function runPine(bars, { score, er, close }) {
  const alerts = [];
  let inCall = false;
  let inPut = false;
  let lastExitBar = null;
  let lastEntryBar = null;
  let callStreak = 0;
  let putStreak = 0;

  for (let i = 0; i < bars.length; i++) {
    const openMs = tsOf(bars[i]);
    const s = score[i];
    const barCloseMin = minuteOfDay(openMs) + PINE.barMinutes;
    const pastCutoff = barCloseMin >= PINE.entryCutoff;
    const mustSquareOff = barCloseMin >= PINE.squareOff;

    const strongCall = s != null && s >= PINE.entryThreshold;
    const strongPut = s != null && s <= -PINE.entryThreshold;
    callStreak = strongCall ? callStreak + 1 : 0;
    putStreak = strongPut ? putStreak + 1 : 0;
    const regimeOk = er[i] >= PINE.minEfficiencyRatio;

    // Exits first, exactly as Pine orders them, so a same-bar reversal sees the flag cleared.
    const exitCall = inCall && ((s != null && s <= PINE.exitThreshold) || strongPut || mustSquareOff);
    const exitPut = inPut && ((s != null && s >= -PINE.exitThreshold) || strongCall || mustSquareOff);
    if (exitCall) {
      inCall = false;
      lastExitBar = i;
    }
    if (exitPut) {
      inPut = false;
      lastExitBar = i;
    }

    const flat = !inCall && !inPut;
    const cooled = lastExitBar === null || i - lastExitBar >= PINE.cooldownBars;
    const canEnter = flat && cooled && !pastCutoff && !mustSquareOff && regimeOk;
    const enterCall = canEnter && callStreak >= PINE.confirmBars;
    const enterPut = canEnter && putStreak >= PINE.confirmBars && !enterCall;
    if (enterCall) {
      inCall = true;
      inPut = false;
      lastEntryBar = i;
    }
    if (enterPut) {
      inPut = true;
      inCall = false;
      lastEntryBar = i;
    }

    const barsSince = lastEntryBar === null ? null : i - lastEntryBar;
    const canReassert =
      PINE.reassertEntries && barsSince !== null && barsSince > 0 && barsSince % PINE.reassertBars === 0 &&
      !pastCutoff && !mustSquareOff && regimeOk;
    const reCall = canReassert && inCall && strongCall && !exitCall;
    const rePut = canReassert && inPut && strongPut && !exitPut;

    const emit = (signalType, reassert) => {
      const alertId = `${ALERT_PREFIX}${openMs}-${signalType}`;
      alerts.push({
        barOpenMs: openMs,
        arriveMs: openMs + PINE.barMinutes * MIN + ALERT_LATENCY_MS,
        signalType,
        reassert,
        price: close[i],
        score: s,
        alertId,
        // The exact payload buildAlertMsg() sends, so a replayed row reads like a real one.
        payload: {
          signal_type: signalType,
          symbol: SYMBOL,
          price: close[i],
          score: s,
          timestamp: String(openMs),
          alert_id: alertId,
          er: Math.round(er[i] * 1000) / 1000,
          bar_close_ist: `${String(Math.floor(barCloseMin / 60)).padStart(2, '0')}:${String(barCloseMin % 60).padStart(2, '0')}`,
          past_cutoff: pastCutoff,
          quantity: PINE.orderQty,
        },
      });
    };
    // Same emission order as the Pine alert() calls.
    if (exitCall) emit('CALL_EXIT', false);
    if (exitPut) emit('PUT_EXIT', false);
    if (enterCall) emit('CALL_ENTRY', false);
    if (enterPut) emit('PUT_ENTRY', false);
    if (reCall) emit('CALL_ENTRY', true);
    if (rePut) emit('PUT_ENTRY', true);
  }
  return alerts;
}

// ----------------------------------------------------------------------------
// 2. Bridge — webhook.controller + tradeExecutor + positionMonitor + scheduler
// ----------------------------------------------------------------------------

/**
 * The premium path the monitor would have seen: one sample per minute close,
 * then the time stop on the first poll after maxHoldMinutes. Polls are 30s
 * apart live; minute closes are the finest resolution a replay can stand
 * behind, which is also how the exit rules were originally backtested.
 */
function buildSamples(feed, entryAt) {
  if (!config.exitRulesEnabled) return [];
  const squareOffAt = mc.istToEpoch(mc.istDate(entryAt), config.squareOffIst);
  const holdEnd = config.maxHoldMinutes > 0 ? entryAt + config.maxHoldMinutes * MIN : Infinity;
  const end = Math.min(holdEnd, squareOffAt);

  const samples = [];
  for (let m = Math.floor(entryAt / MIN) * MIN; m + MIN - 1 < end; m += MIN) {
    const c = feed.byMinute.get(m);
    if (c) samples.push({ t: m + MIN - 1, price: Number(c[4]) });
  }
  if (end === holdEnd) {
    // The time stop fires on the first poll AFTER maxHold has elapsed — on
    // average half a poll interval late — not at the instant it elapses. That
    // gap is not cosmetic: with re-asserts on, a position opened on a
    // re-assert bar is time-stopped almost exactly 15 minutes before the next
    // re-assert, and whether that one clears the 15m re-entry cooldown depends
    // on these seconds. Live, it never does.
    const at = holdEnd + TIME_STOP_POLL_LAG_MS;
    const p = ltp(feed, at);
    if (p != null) samples.push({ t: at, price: p });
  }
  return samples;
}

async function simulate(alerts, { runtime, resolve, lastClosedBefore }) {
  const slip = config.paperSlippagePoints;
  const trades = [];
  const outcomes = [];
  const takenByDay = new Map();
  let pos = null;
  let lastClosed = lastClosedBefore;

  const record = (alert, processed, reason, ref = null) => outcomes.push({ alert, processed, reason, ref });

  function advanceMonitor(until) {
    while (pos.next < pos.samples.length && pos.samples[pos.next].t < until) {
      const s = pos.samples[pos.next++];
      pos.peak = Math.max(pos.peak, s.price);
      const reason = evaluate({
        entry: pos.trade.entryPremium,
        current: s.price,
        peak: pos.peak,
        heldMinutes: (s.t - pos.trade.entryAt) / MIN,
      });
      if (reason) return { at: s.t, mark: s.price, reason };
    }
    return null;
  }

  async function closePos(at, mark, reason, exitAlert) {
    const t = pos.trade;
    const exitPremium = mark == null ? null : Math.max(0.05, Number((mark - slip).toFixed(2)));
    const pnl =
      exitPremium != null && t.entryPremium != null
        ? Number(((exitPremium - t.entryPremium) * t.quantity).toFixed(2))
        : null;
    const cost = charges.computeRoundTrip({ entryPremium: t.entryPremium, exitPremium, quantity: t.quantity });
    const index = await dayFeed(INDEX_KEY, pos.date);

    Object.assign(t, {
      exitAt: at,
      exitMark: mark,
      exitPremium,
      exitSpot: exitAlert ? exitAlert.price : ltp(index, at),
      scoreAtExit: exitAlert ? exitAlert.score : null,
      reason,
      pnl,
      cost,
      net: charges.applyToPnl(pnl, cost ? cost.total : null),
      // Live only writes peak_premium once the premium has gone above entry.
      peak: t.entryPremium != null && pos.peak > t.entryPremium ? pos.peak : null,
    });
    lastClosed = { side: pos.side, reason, at, ref: t.ref };
    pos = null;
  }

  /** scheduler.js: anything still open at SQUARE_OFF_IST is closed. */
  async function finishDay() {
    const squareOffAt = mc.istToEpoch(pos.date, config.squareOffIst);
    const hit = advanceMonitor(squareOffAt + 1);
    if (hit) return closePos(hit.at, hit.mark, hit.reason, null);
    return closePos(squareOffAt, ltp(pos.feed, squareOffAt), 'eod_square_off', null);
  }

  async function handleEntry(a, side) {
    const date = mc.istDate(a.arriveMs);
    if (mc.isPastEntryCutoff(a.arriveMs, config)) return record(a, false, `past_entry_cutoff (${config.entryCutoffIst} IST)`);
    if (!mc.isMarketOpen(a.arriveMs, config)) return record(a, false, 'market_closed');

    // tradeExecutor.openPosition's own order: cap, cooldown, contract, state.
    const taken = takenByDay.get(date) || 0;
    if (runtime.maxTradesPerDay > 0 && taken >= runtime.maxTradesPerDay) {
      return record(a, false, `daily_cap_reached: ${taken} of ${runtime.maxTradesPerDay} trades already taken today`);
    }
    if (
      runtime.reEntryCooldownEnabled && runtime.reEntryCooldownMinutes > 0 &&
      lastClosed && RULE_EXITS.has(lastClosed.reason) && lastClosed.side === side
    ) {
      const since = (a.arriveMs - lastClosed.at) / MIN;
      if (since < runtime.reEntryCooldownMinutes) {
        return record(
          a,
          false,
          `re_entry_cooldown: ${lastClosed.reason} on trade ${lastClosed.ref} ${since.toFixed(0)}m ago (need ${runtime.reEntryCooldownMinutes}m)`
        );
      }
    }

    const contract = await resolve({ signalType: a.signalType, price: a.price, at: a.arriveMs });
    if (contract.error) return record(a, false, `instrument_resolution_failed: ${contract.error}`);
    if (pos) return record(a, false, `invalid_state: already IN_${pos.side}`);

    // Live records a position it cannot price rather than refusing it, and
    // the monitor then has nothing to work from — mirrored here.
    let feed;
    let priceNote = null;
    try {
      feed = contract.model ? await modelFeed(contract, date) : await dayFeed(contract.instrumentToken, date);
    } catch (err) {
      feed = { candles: [], byMinute: new Map() };
      priceNote = err.message;
    }
    const mark = ltp(feed, a.arriveMs);
    const trade = {
      ref: `R${trades.length + 1}`,
      alert: a,
      side,
      contract,
      priceSource: contract.model ? 'model' : 'market',
      priceNote,
      fit: feed.model || null,
      // Only an untrustworthy MODEL day is written unpriced; real candles always count.
      confident: !feed.model || feed.model.confident,
      quantity: PINE.orderQty,
      entryAt: a.arriveMs,
      entryMark: mark,
      entryPremium: mark == null ? null : Math.max(0.05, Number((mark + slip).toFixed(2))),
    };
    trades.push(trade);
    takenByDay.set(date, taken + 1);
    pos = {
      trade,
      side,
      date,
      feed,
      peak: trade.entryPremium ?? 0,
      samples: trade.entryPremium == null ? [] : buildSamples(feed, a.arriveMs),
      next: 0,
    };
    return record(a, true, null, trade.ref);
  }

  async function handleExit(a, side) {
    if (!pos || pos.side !== side) {
      return record(a, false, `invalid_state: not in position (current=${pos ? `IN_${pos.side}` : 'FLAT'})`);
    }
    const ref = pos.trade.ref;
    await closePos(a.arriveMs, ltp(pos.feed, a.arriveMs), 'signal', a);
    return record(a, true, null, ref);
  }

  for (const a of alerts) {
    if (pos && mc.istDate(a.arriveMs) !== pos.date) await finishDay();
    if (pos) {
      const hit = advanceMonitor(a.arriveMs);
      if (hit) await closePos(hit.at, hit.mark, hit.reason, null);
    }
    const side = a.signalType.startsWith('CALL') ? 'CALL' : 'PUT';
    if (a.signalType.endsWith('_ENTRY')) await handleEntry(a, side);
    else await handleExit(a, side);
  }
  if (pos) await finishDay();

  return { trades, outcomes };
}

// ----------------------------------------------------------------------------
// Report
// ----------------------------------------------------------------------------
function summarise(trades) {
  const priced = trades.filter((t) => t.net != null);
  const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
  const wins = priced.filter((t) => t.net > 0);
  const losses = priced.filter((t) => t.net <= 0);
  let eq = 0;
  let peakEq = 0;
  let maxDd = 0;
  for (const t of priced) {
    eq += t.net;
    peakEq = Math.max(peakEq, eq);
    maxDd = Math.min(maxDd, eq - peakEq);
  }
  const grossLoss = -sum(losses, (t) => t.net);
  return {
    n: trades.length,
    priced,
    wins,
    losses,
    gross: sum(priced, (t) => t.pnl),
    costs: sum(priced, (t) => t.cost.total),
    net: sum(priced, (t) => t.net),
    avgWin: wins.length ? sum(wins, (t) => t.net) / wins.length : 0,
    avgLoss: losses.length ? sum(losses, (t) => t.net) / losses.length : 0,
    pf: grossLoss > 0 ? sum(wins, (t) => t.net) / grossLoss : null,
    maxDd,
  };
}

function report({ alerts, trades, outcomes, runtime, from, to }) {
  console.log(`\n${'='.repeat(110)}`);
  console.log(`REPLAY ${from} .. ${to}   mode=${MODE}   re-assert ${PINE.reassertEntries ? 'ON (what-if)' : 'off (as on the chart)'}`);
  console.log(
    `bridge: cap ${runtime.maxTradesPerDay}/day (${runtime.source}) · cooldown ${runtime.reEntryCooldownEnabled ? runtime.reEntryCooldownMinutes + 'm' : 'off'} · ` +
      `SL ${config.stopLossPct * 100}% · trail arm ${config.trailArmPct * 100}% / ${config.trailPct * 100}% ` +
      `(floor ${config.trailBreakevenFloor ? 'on' : 'off'}) · time ${config.maxHoldMinutes}m · slip ${config.paperSlippagePoints}/leg`
  );
  console.log('='.repeat(110));

  console.log('\nSIGNALS (what Pine would have sent, and what the bridge would have done with each)\n');
  let day = null;
  for (const o of outcomes) {
    const a = o.alert;
    const d = mc.istDate(a.arriveMs);
    if (d !== day) {
      day = d;
      console.log(`  ${d}`);
    }
    const what = o.processed ? `-> ${o.ref}` : `skip: ${o.reason}`;
    console.log(
      `    ${hhmm(a.arriveMs)}  ${(a.signalType + (a.reassert ? '*' : '')).padEnd(12)} score ${String(a.score).padStart(2)}  ` +
        `er ${a.payload.er.toFixed(2)}  spot ${a.price.toFixed(2).padStart(9)}   ${what}`
    );
  }
  if (PINE.reassertEntries) console.log('  (* = re-assert of an entry Pine already holds)');

  console.log('\nTRADES   (src: mkt = real option candles, mdl = expired contract, modelled)\n');
  console.log('  ref  date        side src  contract                       in     out    entry    exit    peak  reason          gross   charges       net');
  console.log('  ' + '-'.repeat(138));
  for (const t of trades) {
    console.log(
      `  ${t.ref.padEnd(4)} ${mc.istDate(t.entryAt)}  ${t.side.padEnd(4)} ${t.priceSource === 'model' ? 'mdl' : 'mkt'}  ${t.contract.tradingSymbol.padEnd(28)} ` +
        `${hhmm(t.entryAt)}  ${t.exitAt ? hhmm(t.exitAt) : '  —  '}  ${String(t.entryPremium ?? '—').padStart(7)} ` +
        `${String(t.exitPremium ?? '—').padStart(7)} ${String(t.peak ?? '').padStart(7)}  ${String(t.reason).padEnd(14)} ` +
        `${money(t.pnl)} ${money(t.cost ? t.cost.total : null)} ${money(t.net)}` +
        (t.priceNote ? `   UNPRICED: ${t.priceNote}` : '')
    );
    if (t.fit) {
      // How well that day's model reproduced the contract's real prints —
      // the number to look at before trusting a modelled trade.
      console.log(
        `         model: vol ${(t.fit.vol * 100).toFixed(1)}% (VIX x ${t.fit.kappa.toFixed(2)}), worst miss ${(t.fit.worstMiss * 100).toFixed(1)}%` +
          `${t.confident ? '' : `  -> NOT TRUSTED (${t.fit.why}): written UNPRICED`}   real/model ` +
          Object.entries(t.fit.fit).map(([k, v]) => `${k} ${v.real}/${v.model}`).join('  ')
      );
    }
  }

  const untrusted = trades.filter((t) => !t.confident);
  if (untrusted.length) {
    console.log(
      `\n  ${untrusted.length} modelled trade(s) failed the fit test and are excluded from the P&L below — ` +
        `their model figures, for reference only: ${untrusted.map((t) => `${t.ref} ${money(t.net).trim()}`).join(', ')}`
    );
  }

  const s = summarise(trades.filter((t) => t.confident));
  console.log('\nSUMMARY\n');
  console.log(
    `  Pine alerts             ${alerts.length}  (entries ${alerts.filter((a) => a.signalType.endsWith('ENTRY') && !a.reassert).length}, ` +
      `re-asserts ${alerts.filter((a) => a.reassert).length}, exits ${alerts.filter((a) => a.signalType.endsWith('EXIT')).length})`
  );
  console.log(`  trades opened           ${trades.length}   priced ${s.priced.length}   unpriced ${trades.length - s.priced.length}`);
  if (s.priced.length) {
    console.log(`  win rate (net)          ${((s.wins.length / s.priced.length) * 100).toFixed(0)}%  (${s.wins.length}W / ${s.losses.length}L)`);
    console.log(`  gross P&L               ${money(s.gross)}`);
    console.log(`  charges                 ${money(-s.costs)}`);
    console.log(`  NET P&L                 ${money(s.net)}   (${money(s.net / s.priced.length).trim()} / trade)`);
    console.log(`  avg win / avg loss      ${money(s.avgWin).trim()} / ${money(s.avgLoss).trim()}`);
    console.log(`  profit factor           ${s.pf == null ? 'n/a' : s.pf.toFixed(2)}`);
    console.log(`  max drawdown (net)      ${money(s.maxDd)}`);

    const group = (keyFn) => {
      const g = new Map();
      for (const t of s.priced) {
        const k = keyFn(t);
        const v = g.get(k) || { n: 0, w: 0, net: 0 };
        v.n += 1;
        v.w += t.net > 0 ? 1 : 0;
        v.net += t.net;
        g.set(k, v);
      }
      return [...g.entries()];
    };
    const line = ([k, v]) => `    ${String(k).padEnd(14)} ${String(v.n).padStart(3)} trades  ${String(v.w).padStart(2)}W   ${money(v.net)}`;
    console.log('\n  by price source');
    group((t) => (t.priceSource === 'model' ? 'model (Sep)' : 'real candles')).forEach((x) => console.log(line(x)));
    console.log('  by side');
    group((t) => t.side).forEach((x) => console.log(line(x)));
    console.log('  by exit');
    group((t) => t.reason).forEach((x) => console.log(line(x)));
    console.log('  by day');
    group((t) => mc.istDate(t.entryAt)).forEach((x) => console.log(line(x)));
  }

  const skipped = new Map();
  for (const o of outcomes.filter((x) => !x.processed)) {
    const k = o.reason.split(':')[0].split(' (')[0];
    skipped.set(k, (skipped.get(k) || 0) + 1);
  }
  if (skipped.size) {
    console.log('\n  alerts the bridge would have skipped');
    for (const [k, v] of skipped) console.log(`    ${k.padEnd(30)} ${v}`);
  }
}

// ----------------------------------------------------------------------------
// Database
// ----------------------------------------------------------------------------
async function dbReachable() {
  if (OFFLINE) return false;
  try {
    const { error } = await dbq(supabase.from('trades').select('id').eq('mode', MODE).limit(1));
    if (error) {
      console.log(`  database not usable: ${error.message}`);
      return false;
    }
    return true;
  } catch (err) {
    console.log(`  database not reachable: ${err.message}`);
    return false;
  }
}

const isReplayLog = (row) => row.raw_payload && row.raw_payload.replay === true;

async function lastRealAlertDate() {
  const { data, error } = await dbq(
    supabase.from('webhook_log').select('received_at, raw_payload').order('received_at', { ascending: false }).limit(500)
  );
  if (error) throw new Error(`webhook_log read failed: ${error.message}`);
  const real = (data || []).find((r) => !isReplayLog(r));
  return real ? real.received_at : null;
}

async function readRuntime(online) {
  const fallback = {
    maxTradesPerDay: config.maxTradesPerDay,
    reEntryCooldownEnabled: config.reEntryCooldownMinutes > 0,
    reEntryCooldownMinutes: config.reEntryCooldownMinutes,
    source: 'env',
  };
  if (!online) return fallback;
  const { data, error } = await dbq(
    supabase.from('app_config').select('max_trades_per_day, re_entry_cooldown_enabled, re_entry_cooldown_minutes').eq('mode', MODE).maybeSingle()
  );
  if (error || !data) return fallback;
  return {
    maxTradesPerDay: Number(data.max_trades_per_day),
    reEntryCooldownEnabled: Boolean(data.re_entry_cooldown_enabled),
    reEntryCooldownMinutes: Number(data.re_entry_cooldown_minutes),
    source: 'app_config',
  };
}

async function lastClosedBefore(online, beforeMs) {
  if (!online) return null;
  const { data } = await dbq(
    supabase
      .from('trades')
      .select('id, signal_type, closed_reason, closed_at')
      .eq('mode', MODE)
      .eq('status', 'CLOSED')
      .lt('closed_at', iso(beforeMs))
      .order('closed_at', { ascending: false })
      .limit(1)
      .maybeSingle()
  );
  if (!data) return null;
  return {
    side: String(data.signal_type).startsWith('CALL') ? 'CALL' : 'PUT',
    reason: data.closed_reason,
    at: new Date(data.closed_at).getTime(),
    ref: data.id,
  };
}

/** Everything already in the window, split into real activity and earlier replays. */
async function windowContents(fromMs, toMs) {
  const [logs, trades, alerts] = await Promise.all([
    dbq(supabase.from('webhook_log').select('id, received_at, raw_payload').gte('received_at', iso(fromMs)).lt('received_at', iso(toMs))),
    dbq(supabase.from('trades').select('id, created_at, entry_fill_source, status').eq('mode', MODE).gte('created_at', iso(fromMs)).lt('created_at', iso(toMs))),
    dbq(supabase.from('processed_alerts').select('alert_id, received_at').eq('mode', MODE).gte('received_at', iso(fromMs)).lt('received_at', iso(toMs))),
  ]);
  for (const r of [logs, trades, alerts]) if (r.error) throw new Error(r.error.message);
  return {
    realLogs: logs.data.filter((r) => !isReplayLog(r)),
    replayLogs: logs.data.filter(isReplayLog),
    realTrades: trades.data.filter((t) => !isReplayFill(t.entry_fill_source)),
    replayTrades: trades.data.filter((t) => isReplayFill(t.entry_fill_source)),
    replayAlerts: alerts.data.filter((a) => a.alert_id.startsWith(ALERT_PREFIX)),
  };
}

function undoHint(from, to) {
  return `node scripts/replay-signals.js --undo --from ${from} --to ${to} --apply`;
}

async function applyResult({ trades, outcomes, from, to, fromMs, toMs }) {
  const existing = await windowContents(fromMs, toMs);
  if (existing.realLogs.length || existing.realTrades.length) {
    throw new Error(
      `TradingView was live inside ${from}..${to} (${existing.realLogs.length} real webhooks, ${existing.realTrades.length} real trades). ` +
        'Replaying it would double count — pick a window that starts after the last real alert.'
    );
  }
  if (existing.replayLogs.length || existing.replayTrades.length || existing.replayAlerts.length) {
    throw new Error(`This window already holds replay rows. To redo it: ${undoHint(from, to)} — then --apply again.`);
  }

  const replayedAt = new Date().toISOString();
  const step = async (label, run) => {
    const { data, error } = await run();
    if (error) throw new Error(`${label} failed: ${error.message}. Clean up with: ${undoHint(from, to)}`);
    return data;
  };

  // processed_alerts first: trades.alert_id references it.
  await step('processed_alerts insert', () =>
    supabase.from('processed_alerts').insert(
      outcomes.map((o) => ({
        alert_id: o.alert.alertId,
        symbol: SYMBOL,
        signal_type: o.alert.signalType,
        mode: MODE,
        received_at: iso(o.alert.arriveMs),
      }))
    )
  );

  const tradeRows = trades.map((t) => {
    const source = t.priceSource === 'model' ? FILL_MODEL : FILL_MARK;
    // An untrusted model day keeps its timeline and drops every money figure —
    // the same rule tradeExecutor applies to a leg it cannot price.
    const ifTrusted = (v) => (t.confident ? v : null);
    return {
      alert_id: t.alert.alertId,
      signal_type: t.alert.signalType,
      symbol: SYMBOL,
      instrument_token: t.contract.instrumentToken,
      quantity: t.quantity,
      entry_price: ifTrusted(t.entryPremium),
      exit_price: ifTrusted(t.exitPremium),
      entry_spot: t.alert.price,
      exit_spot: t.exitSpot,
      score_at_entry: t.alert.score,
      score_at_exit: t.scoreAtExit,
      status: 'CLOSED',
      pnl: ifTrusted(t.pnl),
      charges: ifTrusted(t.cost ? t.cost.total : null),
      charges_breakdown: ifTrusted(t.cost),
      entry_fill_source: source,
      exit_fill_source: source,
      broker_entry_status: BROKER_STATUS,
      broker_exit_status: BROKER_STATUS,
      closed_reason: t.reason,
      peak_premium: ifTrusted(t.peak),
      mode: MODE,
      created_at: iso(t.entryAt),
      closed_at: iso(t.exitAt),
    };
  });
  const inserted = tradeRows.length
    ? await step('trades insert', () => supabase.from('trades').insert(tradeRows).select('id, alert_id'))
    : [];
  const idByAlert = new Map(inserted.map((r) => [r.alert_id, r.id]));
  const idByRef = new Map(trades.map((t) => [t.ref, idByAlert.get(t.alert.alertId)]));

  await step('webhook_log insert', () =>
    supabase.from('webhook_log').insert(
      outcomes.map((o) => ({
        raw_payload: { ...o.alert.payload, replay: true, replay_source: 'upstox_candles', replayed_at: replayedAt },
        processed: o.processed,
        // Replay refs (R3) become the real trade ids, so the cooldown gloss links up.
        reason: o.reason ? o.reason.replace(/on trade (R\d+)/, (m, ref) => `on trade ${idByRef.get(ref) ?? ref}`) : null,
        received_at: iso(o.alert.arriveMs),
      }))
    )
  );

  console.log(`\nAPPLIED: ${outcomes.length} replayed alerts, ${inserted.length} paper trades written (ids ${inserted.map((r) => r.id).join(', ') || '—'}).`);
  console.log(`Undo at any time with: ${undoHint(from, to)}`);
}

async function undoReplay({ from, to, fromMs, toMs }) {
  const c = await windowContents(fromMs, toMs);
  console.log(`replay rows in ${from}..${to}: ${c.replayTrades.length} trades, ${c.replayAlerts.length} processed_alerts, ${c.replayLogs.length} webhook_log`);
  if (!APPLY) {
    console.log('DRY RUN — nothing deleted. Add --apply to delete exactly these rows.');
    return;
  }
  // trades before processed_alerts (FK). Real rows are never matched: every
  // filter below keys on a replay-only marker.
  const ids = c.replayTrades.map((t) => t.id);
  if (ids.length) {
    const { error } = await supabase.from('trades').delete().in('id', ids).like('entry_fill_source', `${FILL_MARK}%`);
    if (error) throw new Error(`trades delete failed: ${error.message}`);
  }
  const alertIds = c.replayAlerts.map((a) => a.alert_id);
  if (alertIds.length) {
    const { error } = await supabase.from('processed_alerts').delete().eq('mode', MODE).in('alert_id', alertIds);
    if (error) throw new Error(`processed_alerts delete failed: ${error.message}`);
  }
  const logIds = c.replayLogs.map((l) => l.id);
  if (logIds.length) {
    const { error } = await supabase.from('webhook_log').delete().in('id', logIds);
    if (error) throw new Error(`webhook_log delete failed: ${error.message}`);
  }
  console.log('Deleted.');
}

// ----------------------------------------------------------------------------
// Validation
// ----------------------------------------------------------------------------

/**
 * How faithful is the signal replica? Compares it bar for bar with alerts
 * TradingView actually sent. Only payloads from the current script version
 * (they carry bar_close_ist) are comparable — older versions had different
 * exit rules.
 */
async function validateSignals({ alerts, scoreByBar, fromMs, toMs, from, to }) {
  const { data, error } = await dbq(
    supabase.from('webhook_log').select('received_at, raw_payload').gte('received_at', iso(fromMs)).lt('received_at', iso(toMs)).order('received_at')
  );
  if (error) throw new Error(error.message);
  const real = data
    .filter((r) => !isReplayLog(r) && r.raw_payload?.signal_type && r.raw_payload?.timestamp && r.raw_payload?.bar_close_ist)
    .map((r) => r.raw_payload);
  if (!real.length) {
    console.log(`\nVALIDATION ${from}..${to}: no alerts from the current script version in this window.`);
    return;
  }

  // Compare only from the first day the current version was live — before it,
  // every replica alert would count as "extra" against alerts it never had a
  // chance to match.
  const versionFrom = Math.max(fromMs, mc.istToEpoch(mc.istDate(Number(real[0].timestamp)), '00:00'));
  const key = (bar, type) => `${bar}|${type}`;
  const mine = new Map(
    alerts.filter((a) => a.arriveMs >= versionFrom && a.arriveMs < toMs).map((a) => [key(a.barOpenMs, a.signalType), a])
  );
  const theirs = new Map(real.map((p) => [key(Number(p.timestamp), p.signal_type), p]));
  console.log(`\n  current script version first seen ${mc.istDate(versionFrom)} — comparing from there`);

  let both = 0;
  const onlyReal = [];
  for (const [k, p] of theirs) {
    if (mine.has(k)) both++;
    else onlyReal.push(p);
  }
  const onlyMine = [...mine.entries()].filter(([k]) => !theirs.has(k)).map(([, a]) => a);

  let barsChecked = 0;
  let barsSame = 0;
  for (const p of real) {
    const s = scoreByBar.get(Number(p.timestamp));
    if (s === undefined) continue;
    barsChecked++;
    if (s === Number(p.score)) barsSame++;
  }

  console.log(`\nSIGNAL VALIDATION ${from}..${to}   (real alerts from the current script version: ${theirs.size})`);
  console.log(`  same alert on the same bar:   ${both} of ${theirs.size} real  (${((both / theirs.size) * 100).toFixed(0)}%)`);
  console.log(`  replica-only alerts:          ${onlyMine.length}`);
  console.log(`  score identical on alert bars ${barsSame} of ${barsChecked}`);

  const days = new Map();
  const bump = (ms, field) => {
    const d = mc.istDate(ms);
    const v = days.get(d) || { real: 0, mine: 0, both: 0 };
    v[field] += 1;
    days.set(d, v);
  };
  for (const p of theirs.values()) bump(Number(p.timestamp), 'real');
  for (const [k, a] of mine) {
    bump(a.barOpenMs, 'mine');
    if (theirs.has(k)) bump(a.barOpenMs, 'both');
  }
  console.log('\n  day          real  replica  matched');
  for (const [d, v] of [...days.entries()].sort()) {
    console.log(`  ${d}  ${String(v.real).padStart(4)}  ${String(v.mine).padStart(7)}  ${String(v.both).padStart(7)}`);
  }
  console.log('\n  real alerts the replica missed:');
  for (const p of onlyReal.slice(0, 25)) {
    const bar = Number(p.timestamp);
    console.log(`    ${mc.istString(bar).slice(0, 16)}  ${p.signal_type.padEnd(11)} TV score ${String(p.score).padStart(2)}   replica score ${String(scoreByBar.get(bar)).padStart(4)}`);
  }
  console.log('\n  replica alerts TradingView did not send:');
  for (const a of onlyMine.slice(0, 25)) {
    console.log(`    ${mc.istString(a.barOpenMs).slice(0, 16)}  ${a.signalType.padEnd(11)} replica score ${String(a.score).padStart(2)}`);
  }
}

/**
 * How good is the expired-contract model, and the bridge replica around it?
 *
 *   A. Pricing: every real trade in the window whose contract has since
 *      expired is re-priced by the model, and compared with the premiums the
 *      live monitor actually recorded (trade_premium_samples) and the entry /
 *      exit marks it actually booked.
 *   B. Bridge: the REAL alerts of the window are fed through the replay bridge
 *      with model pricing, and the trades it takes are compared with the
 *      trades that really happened. Same alerts on both sides, so any
 *      difference is the bridge replica or the pricing — not the signal.
 */
async function validateModel({ fromMs, toMs, from, to, resolve, runtime }) {
  const slip = config.paperSlippagePoints;
  const { data: trades, error } = await dbq(
    supabase
      .from('trades')
      .select('id, alert_id, signal_type, instrument_token, created_at, closed_at, entry_price, exit_price, pnl, closed_reason, entry_fill_source, status')
      .eq('mode', MODE)
      .gte('created_at', iso(fromMs))
      .lt('created_at', iso(toMs))
      .order('created_at')
  );
  if (error) throw new Error(error.message);
  const real = trades.filter((t) => !isReplayFill(t.entry_fill_source));
  const closed = real.filter((t) => t.status === 'CLOSED' && t.entry_price != null && t.exit_price != null);

  console.log(`\nMODEL VALIDATION ${from}..${to}`);
  console.log('\nA. PRICING — model vs the premiums the live monitor recorded\n');
  console.log('  trade  contract                       entry mark  model     exit mark  model     samples  med |err|   bias   move real  move model');
  const allErr = [];
  const moves = [];
  for (const t of closed) {
    const date = mc.istDate(new Date(t.created_at).getTime());
    const bhav = await bhavcopy(date);
    const row = bhav.options.find((o) => `NSE_FO|${o.token}` === t.instrument_token);
    if (!row || expiryEndMs(row.expiry) > Date.now()) continue; // only contracts the model is for
    const contract = await resolve({
      signalType: t.signal_type,
      price: row.strike, // resolves to exactly this strike
      at: new Date(t.created_at).getTime(),
    });
    if (contract.error || contract.instrumentToken !== t.instrument_token) continue;
    const feed = await modelFeed(contract, date);

    const entryAt = new Date(t.created_at).getTime();
    const exitAt = new Date(t.closed_at).getTime();
    const realEntry = Number(t.entry_price) - slip;
    const realExit = Number(t.exit_price) + slip;
    const mEntry = ltp(feed, entryAt);
    const mExit = ltp(feed, exitAt);

    const { data: samples } = await dbq(supabase.from('trade_premium_samples').select('premium, sampled_at').eq('trade_id', t.id).order('sampled_at'));
    const errs = (samples || [])
      .map((s) => {
        const m = ltp(feed, new Date(s.sampled_at).getTime());
        return m == null ? null : (m - Number(s.premium)) / Number(s.premium);
      })
      .filter((e) => e != null);
    allErr.push(...errs);
    const med = errs.length ? [...errs].map(Math.abs).sort((a, b) => a - b)[Math.floor(errs.length / 2)] : null;
    const bias = errs.length ? errs.reduce((s, e) => s + e, 0) / errs.length : null;
    moves.push({ real: realExit - realEntry, model: mExit - mEntry });

    console.log(
      `  ${String(t.id).padEnd(5)}  ${contract.tradingSymbol.padEnd(28)}  ${realEntry.toFixed(2).padStart(9)}  ${String(mEntry).padStart(7)}  ` +
        `${realExit.toFixed(2).padStart(9)}  ${String(mExit).padStart(7)}  ${String(errs.length).padStart(7)}  ` +
        `${med == null ? '     —' : (med * 100).toFixed(1).padStart(6) + '%'}  ${bias == null ? '    —' : ((bias * 100).toFixed(1) + '%').padStart(6)}  ` +
        `${(realExit - realEntry).toFixed(2).padStart(9)}  ${(mExit - mEntry).toFixed(2).padStart(10)}`
    );
    const f = feed.model.fit;
    console.log(
      `         day fit: vol ${(feed.model.vol * 100).toFixed(1)}% (VIX x ${feed.model.kappa.toFixed(2)})   real/model  ` +
        Object.entries(f).map(([k, v]) => `${k} ${v.real}/${v.model}`).join('  ')
    );
  }
  if (allErr.length) {
    const abs = allErr.map(Math.abs).sort((a, b) => a - b);
    console.log(
      `\n  ${allErr.length} samples: median |error| ${(abs[Math.floor(abs.length / 2)] * 100).toFixed(1)}%, ` +
        `90th pct ${(abs[Math.floor(abs.length * 0.9)] * 100).toFixed(1)}%, bias ${((allErr.reduce((s, e) => s + e, 0) / allErr.length) * 100).toFixed(1)}%`
    );
  }
  if (moves.length) {
    const sameSign = moves.filter((m) => Math.sign(m.real) === Math.sign(m.model)).length;
    const err = moves.map((m) => Math.abs(m.model - m.real)).sort((a, b) => a - b);
    console.log(
      `  entry->exit move: same direction ${sameSign}/${moves.length}, median |move error| ${err[Math.floor(err.length / 2)].toFixed(2)} pts ` +
        `(Rs.${(err[Math.floor(err.length / 2)] * PINE.orderQty).toFixed(0)} at ${PINE.orderQty} qty)`
    );
  }

  // B. bridge replica on the real alerts
  const { data: logs, error: logErr } = await dbq(
    supabase.from('webhook_log').select('received_at, raw_payload').gte('received_at', iso(fromMs)).lt('received_at', iso(toMs)).order('received_at')
  );
  if (logErr) throw new Error(logErr.message);
  const realAlerts = logs
    .filter((r) => !isReplayLog(r) && r.raw_payload?.signal_type && r.raw_payload?.timestamp)
    .map((r) => {
      const p = r.raw_payload;
      return {
        barOpenMs: Number(p.timestamp),
        arriveMs: new Date(r.received_at).getTime(),
        signalType: p.signal_type,
        reassert: false,
        price: Number(p.price),
        score: Number(p.score),
        alertId: p.alert_id,
        payload: { ...p, er: Number(p.er ?? 0) },
      };
    });
  const sim = await simulate(realAlerts, { runtime, resolve, lastClosedBefore: null });

  console.log('\nB. BRIDGE — the real alerts, replayed, vs the trades that really happened\n');
  console.log('  alert bar          side  REAL: in-out  reason          net       | REPLAY: in-out  reason          net');
  const realByAlert = new Map(real.map((t) => [t.alert_id, t]));
  const simByAlert = new Map(sim.trades.map((t) => [t.alert.alertId, t]));
  const ids = [...new Set([...realByAlert.keys(), ...simByAlert.keys()])].sort();
  let realNet = 0;
  let simNet = 0;
  let sameReason = 0;
  let pairs = 0;
  for (const id of ids) {
    const r = realByAlert.get(id);
    const s = simByAlert.get(id);
    const rNet =
      r && r.pnl != null ? charges.applyToPnl(Number(r.pnl), charges.computeRoundTrip({ entryPremium: r.entry_price, exitPremium: r.exit_price, quantity: PINE.orderQty })?.total ?? null) : null;
    const realPart = r
      ? r.status === 'CLOSED'
        ? `${hhmm(new Date(r.created_at).getTime())}-${hhmm(new Date(r.closed_at).getTime())}  ${String(r.closed_reason).padEnd(14)} ${money(rNet)}`
        : `${r.status} (${String(r.status === 'FAILED' ? 'order failed' : '').padEnd(10)})`.padEnd(37)
      : '—'.padEnd(37);
    const simPart = s ? `${hhmm(s.entryAt)}-${hhmm(s.exitAt)}  ${String(s.reason).padEnd(14)} ${money(s.net)}` : '—';
    const bar = Number(String(id).split('-')[0]);
    console.log(`  ${mc.istString(bar).slice(5, 16)}  ${String(r?.signal_type || s?.alert.signalType).slice(0, 4).padEnd(4)}  ${realPart} | ${simPart}`);
    if (r && s && r.status === 'CLOSED' && s.net != null && rNet != null) {
      pairs++;
      realNet += rNet;
      simNet += s.net;
      if (r.closed_reason === s.reason) sameReason++;
    }
  }
  console.log(`\n  trades both sides took: ${pairs}   same exit reason: ${sameReason}/${pairs}`);
  console.log(`  net on those trades — real ${money(realNet).trim()}   replay ${money(simNet).trim()}`);
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
async function main() {
  const today = mc.istDate();
  console.log('checking database...');
  const online = await dbReachable();
  if ((APPLY || UNDO || VALIDATE || VALIDATE_MODEL) && !online) {
    throw new Error('the database is required for --apply / --undo / --validate / --validate-model and is not reachable right now');
  }

  let from = argValue('from');
  if (!from) {
    if (!online) throw new Error('--from is required while the database is unreachable (normally it is the day after the last real alert)');
    const last = await lastRealAlertDate();
    if (!last) throw new Error('no real webhook in webhook_log to start after — pass --from');
    from = addDays(mc.istDate(new Date(last).getTime()), 1);
    console.log(`last real TradingView alert: ${mc.istString(new Date(last).getTime())} IST -> replaying from ${from}`);
  }
  const to = argValue('to') || today;
  if (to < from) throw new Error(`--to ${to} is before --from ${from}`);
  const fromMs = mc.istToEpoch(from, '00:00');
  const toMs = mc.istToEpoch(addDays(to, 1), '00:00');

  if (UNDO) return undoReplay({ from, to, fromMs, toMs });

  console.log(`loading BANKNIFTY 5-minute candles ${addDays(from, -WARMUP_DAYS)} .. ${to} (warm-up ${WARMUP_DAYS} days)...`);
  const bars = await loadCandles(INDEX_KEY, 5, addDays(from, -WARMUP_DAYS), to);
  const tradingDays = new Set(bars.map((b) => mc.istDate(tsOf(b))));
  const windowDays = [...tradingDays].filter((d) => d >= from && d <= to).sort();
  console.log(`  ${bars.length} bars; trading days in window: ${windowDays.join(' ') || 'none'}`);
  if (to === today && mc.isMarketOpen(Date.now(), config)) {
    console.log('  WARNING: the session is still open — today is only partly replayed.');
  }

  const scored = buildScore(bars);
  const scoreByBar = new Map(bars.map((b, i) => [tsOf(b), scored.score[i]]));
  const allAlerts = runPine(bars, scored);
  const alerts = allAlerts.filter((a) => a.arriveMs >= fromMs && a.arriveMs < toMs);

  if (VALIDATE) return validateSignals({ alerts: allAlerts, scoreByBar, fromMs, toMs, from, to });

  console.log('loading the instrument master...');
  const contracts = await loadContracts();
  const expired = expiredCycleEnd(contracts, tradingDays);
  if (fromMs <= expired.endMs) {
    console.log(`  entries up to ${expired.date} traded a contract that has since expired — those are priced by the model (src mdl).`);
  }
  const resolve = makeResolver(contracts, expired);
  const runtime = await readRuntime(online);

  if (VALIDATE_MODEL) return validateModel({ fromMs, toMs, from, to, resolve, runtime });

  const result = await simulate(alerts, { runtime, resolve, lastClosedBefore: await lastClosedBefore(online, fromMs) });
  report({ alerts, ...result, runtime, from, to });

  if (APPLY) {
    // Deliberately unpriced (an untrusted model day) is fine; unpriced by
    // accident (data missing) means the run is incomplete.
    const unpriced = result.trades.filter((t) => t.pnl == null && t.confident);
    if (unpriced.length) throw new Error(`${unpriced.length} trade(s) could not be priced — refusing to write a partial result`);
    await applyResult({ ...result, from, to, fromMs, toMs });
  } else {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to record these as paper trades.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\nFATAL ${err.message}`);
    process.exit(1);
  });
