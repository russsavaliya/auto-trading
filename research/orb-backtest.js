'use strict';
/**
 * Opening Range Breakout — offline backtest on Upstox BANKNIFTY index data.
 *
 * WHY ORB, AND WHY IT CAN BE TESTED THIS WAY
 * The live score system is measurably dead (profit factor 0.516 over
 * TradingView's own Feb-Aug run; 30% win rate over 57 live trades). The one
 * structure that survived every slice of the live data was the FIRST trade of
 * the day — monotonically better the fewer trades were taken, in two
 * independent windows. That points at the opening move, which is what this
 * tests directly.
 *
 * Crucially, ORB can be backtested against Upstox data in a way the score
 * cannot. The score is built from threshold comparisons (close > emaSlow,
 * rsi > 55); TradingView and Upstox 5-minute bars differ by ~0.45 points on
 * average, which flips those comparisons and made replication impossible
 * (49% bar-for-bar agreement). ORB levels are actual price extremes and a
 * breakout is decided by a move of tens of points, so a sub-point difference
 * in the bars changes almost nothing.
 *
 * Everything here is index points. 1 index point ~= Rs.18 at 30 qty and an ATM
 * delta of 0.6 (measured: median 0.61 across live trades). Costs are charged as
 * COST_POINTS per side, matching the ~Rs.90 round-trip friction seen live.
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const KEY = encodeURIComponent('NSE_INDEX|Nifty Bank');
const CACHE = path.join(require('os').tmpdir(), 'banknifty-5m-cache.json');
const COST_POINTS = 2.5;          // per side
const RUPEES_PER_POINT = 18;      // 0.6 delta x 30 qty

const IST = 'Asia/Kolkata';
const istStr = (t) => new Date(t).toLocaleString('sv-SE', { timeZone: IST });
const istDate = (t) => istStr(t).slice(0, 10);
const istHHMM = (t) => istStr(t).slice(11, 16);
const mins = (hhmm) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);

async function fetchChunk(from, to) {
  const url = `https://api.upstox.com/v3/historical-candle/${KEY}/minutes/5/${to}/${from}`;
  const r = await axios.get(url, { timeout: 60000, headers: { Accept: 'application/json' } });
  return r.data?.data?.candles || [];
}

/** Upstox rejects long ranges for intraday intervals, so page ~25 days at a time. */
async function loadHistory(monthsBack) {
  if (fs.existsSync(CACHE)) {
    const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (c.monthsBack >= monthsBack) { console.log(`(using cache: ${c.candles.length} candles)`); return c.candles; }
  }
  const out = new Map();
  const end = new Date('2026-08-21T00:00:00Z');
  for (let i = 0; i < monthsBack * 30 / 25 + 1; i++) {
    const to = new Date(end); to.setUTCDate(to.getUTCDate() - i * 25);
    const from = new Date(to); from.setUTCDate(from.getUTCDate() - 25);
    const f = from.toISOString().slice(0, 10), t = to.toISOString().slice(0, 10);
    try {
      const c = await fetchChunk(f, t);
      c.forEach((x) => out.set(x[0], x));
      process.stdout.write(`\r  fetched ${f} .. ${t}  (${out.size} candles)   `);
    } catch (e) { process.stdout.write(`\r  ${f}..${t} failed (${e.response?.status || e.message})   `); }
  }
  console.log('');
  const candles = [...out.values()].sort((a, b) => new Date(a[0]) - new Date(b[0]));
  fs.writeFileSync(CACHE, JSON.stringify({ monthsBack, candles }));
  return candles;
}

/**
 * One day's trades under one parameter set.
 * bars: ascending 5-min candles for a single IST day.
 */
function runDay(bars, p) {
  const open = bars.filter((b) => mins(istHHMM(new Date(b[0]).getTime())) >= 555); // from 09:15
  if (open.length < 10) return [];

  const orEnd = 555 + p.orMinutes;
  const orBars = open.filter((b) => mins(istHHMM(new Date(b[0]).getTime())) < orEnd);
  if (!orBars.length) return [];

  const orHigh = Math.max(...orBars.map((b) => +b[2]));
  const orLow = Math.min(...orBars.map((b) => +b[3]));
  const orRange = orHigh - orLow;
  if (orRange <= 0) return [];
  // A range this tight is a data artefact or a dead open; a breakout off it is noise.
  if (p.minRangePoints && orRange < p.minRangePoints) return [];
  if (p.maxRangePoints && orRange > p.maxRangePoints) return [];

  const after = open.filter((b) => mins(istHHMM(new Date(b[0]).getTime())) >= orEnd);
  const trades = [];
  let i = 0;

  while (i < after.length && trades.length < p.maxTrades) {
    // find the breakout bar
    let dir = 0, entryBar = null;
    for (; i < after.length; i++) {
      const b = after[i];
      const m = mins(istHHMM(new Date(b[0]).getTime()));
      if (m >= p.entryCutoff) { i = after.length; break; }
      if (+b[4] > orHigh + p.buffer) { dir = 1; entryBar = b; i++; break; }
      if (+b[4] < orLow - p.buffer) { dir = -1; entryBar = b; i++; break; }
    }
    if (!dir) break;

    const entry = +entryBar[4] + dir * COST_POINTS;
    const stopDist = p.stopMode === 'range' ? orRange * p.stopFactor : p.stopPoints;
    // trailMode 'none' must mean NO trail. Falling through to trailPoints here
    // silently applied a fixed 40-point trail and made the 'trail off' sweep row
    // meaningless.
    const trailDist = p.trailMode === 'none' ? 0 : (p.trailMode === 'range' ? orRange * p.trailFactor : p.trailPoints);
    let best = entry, exit = null, why = null, heldBars = 0;

    for (let j = i; j < after.length; j++) {
      const b = after[j];
      const m = mins(istHHMM(new Date(b[0]).getTime()));
      heldBars = j - i + 1;
      const hi = +b[2], lo = +b[3], cl = +b[4];

      // stop first (worst case within the bar)
      const stopAt = dir === 1 ? entry - stopDist : entry + stopDist;
      if (dir === 1 ? lo <= stopAt : hi >= stopAt) { exit = stopAt; why = 'stop'; i = j + 1; break; }

      // The trail must be measured against the extreme as of the END OF THE
      // PREVIOUS bar, then `best` updated afterwards.
      //
      // Updating `best` from THIS bar's high and then testing THIS bar's low
      // against it assumes the high printed before the low — which the candle
      // does not tell us. That ordering assumption is a look-ahead: on any bar
      // that fell first and rallied later it exits at a price that was not
      // available yet, and it manufactures edge out of nothing.
      const armed = dir === 1 ? best >= entry + p.armPoints : best <= entry - p.armPoints;
      if (armed && trailDist > 0) {
        const tr = dir === 1 ? best - trailDist : best + trailDist;
        if (dir === 1 ? lo <= tr : hi >= tr) { exit = tr; why = 'trail'; i = j + 1; break; }
      }
      best = dir === 1 ? Math.max(best, hi) : Math.min(best, lo);
      if (p.maxHoldBars && heldBars >= p.maxHoldBars) { exit = cl; why = 'time'; i = j + 1; break; }
      if (m + 5 >= p.squareOff) { exit = cl; why = 'eod'; i = j + 1; break; }
      if (j === after.length - 1) { exit = cl; why = 'eod'; i = j + 1; }
    }
    if (exit === null) break;

    const gross = dir === 1 ? exit - entry : entry - exit;
    trades.push({ dir, entry, exit, why, points: gross - COST_POINTS, heldBars, orRange, t: istHHMM(new Date(entryBar[0]).getTime()) });
  }
  return trades;
}

function backtest(byDay, p) {
  let pts = 0, n = 0, w = 0; const why = {}; const daily = [];
  for (const d of Object.keys(byDay).sort()) {
    const ts = runDay(byDay[d], p);
    let dp = 0;
    for (const t of ts) { pts += t.points; dp += t.points; n++; if (t.points > 0) w++; why[t.why] = (why[t.why] || 0) + 1; }
    if (ts.length) daily.push({ d, pts: dp, n: ts.length });
  }
  return { pts, n, w, why, daily };
}

module.exports = { loadHistory, runDay, backtest, istDate, istHHMM, mins, RUPEES_PER_POINT, COST_POINTS };
