'use strict';
/**
 * Is the morning edge real, or is it seven lucky live trades?
 *
 * The live evidence for "the first trade of the day is the good one" is 10
 * trades over 10 days. That is far too few to act on. This asks the same
 * question of 12 months of BANKNIFTY 5-minute data, and — critically — asks it
 * against the same NULL that orb-validate.js uses: if random entries taken in
 * the same time window do just as well, the window is not an edge, it is just
 * where the volatility is.
 *
 * Reported in index points. RUPEES_PER_POINT (18) = 0.6 ATM delta x 30 qty.
 */
const { loadHistory, runDay, istDate, istHHMM, mins, RUPEES_PER_POINT, COST_POINTS } = require('./orb-backtest');

const P = {
  orMinutes: 30, buffer: 0, maxTrades: 3,
  stopMode: 'range', stopFactor: 0.5, stopPoints: 60,
  trailMode: 'range', trailFactor: 1.0, trailPoints: 40,
  armPoints: 20, maxHoldBars: 0,
  entryCutoff: 14 * 60 + 45, squareOff: 15 * 60 + 15,
  minRangePoints: 0, maxRangePoints: 0,
};

const R = (p) => (p * RUPEES_PER_POINT >= 0 ? '+' : '−') + 'Rs.' + Math.abs(Math.round(p * RUPEES_PER_POINT)).toLocaleString('en-IN');
const sum = (a) => a.reduce((s, v) => s + v, 0);

/**
 * Per-day view computed ONCE.
 *
 * istHHMM goes through Intl.toLocaleString, which is orders of magnitude
 * slower than the arithmetic around it. Recomputing these filters inside the
 * 20-run x 6-bucket null loop meant ~10 million of those calls and turned a
 * two-second job into minutes. The bar's minute-of-day is resolved here and
 * carried alongside the bar from then on.
 */
function prepDay(bars, p) {
  const withMin = bars.map((b) => ({ b, m: mins(istHHMM(new Date(b[0]).getTime())) }));
  const open = withMin.filter((x) => x.m >= 555);
  if (open.length < 10) return null;
  const orEnd = 555 + p.orMinutes;
  const orBars = open.filter((x) => x.m < orEnd);
  if (!orBars.length) return null;
  const orRange = Math.max(...orBars.map((x) => +x.b[2])) - Math.min(...orBars.map((x) => +x.b[3]));
  if (orRange <= 0) return null;
  return { after: open.filter((x) => x.m >= orEnd), orRange };
}

/** Same exit machinery as runDay, but entering at a bar chosen by the caller. */
function tradeFrom(after, startIdx, dir, orRange, p) {
  const entryBar = after[startIdx]?.b;
  if (!entryBar) return null;
  const entry = +entryBar[4] + dir * COST_POINTS;
  const stopDist = orRange * p.stopFactor;
  const trailDist = orRange * p.trailFactor;
  let best = entry;

  for (let j = startIdx + 1; j < after.length; j++) {
    const { b, m } = after[j];
    const hi = +b[2], lo = +b[3], cl = +b[4];

    const stopAt = dir === 1 ? entry - stopDist : entry + stopDist;
    if (dir === 1 ? lo <= stopAt : hi >= stopAt) return { points: (dir === 1 ? stopAt - entry : entry - stopAt) - COST_POINTS };

    // Trail measured against the previous bar's extreme — no look-ahead.
    const armed = dir === 1 ? best >= entry + p.armPoints : best <= entry - p.armPoints;
    if (armed && trailDist > 0) {
      const tr = dir === 1 ? best - trailDist : best + trailDist;
      if (dir === 1 ? lo <= tr : hi >= tr) return { points: (dir === 1 ? tr - entry : entry - tr) - COST_POINTS };
    }
    best = dir === 1 ? Math.max(best, hi) : Math.min(best, lo);
    if (m + 5 >= p.squareOff || j === after.length - 1) {
      return { points: (dir === 1 ? cl - entry : entry - cl) - COST_POINTS };
    }
  }
  return null;
}

const BUCKETS = [
  ['09:45-10:15', 585, 615], ['10:15-11:00', 615, 660], ['11:00-12:00', 660, 720],
  ['12:00-13:00', 720, 780], ['13:00-14:00', 780, 840], ['14:00-14:45', 840, 885],
];

(async () => {
  const candles = await loadHistory(12);
  const byDay = {};
  for (const c of candles) { const d = istDate(new Date(c[0]).getTime()); (byDay[d] = byDay[d] || []).push(c); }
  const days = Object.keys(byDay).sort();
  console.log(`\n${days.length} trading days: ${days[0]} .. ${days[days.length - 1]}\n`);

  // ---------- 1. ORB trades bucketed by the time the breakout fired ----------
  const orbByBucket = new Map(BUCKETS.map((b) => [b[0], []]));
  const firstOfDay = [];
  const laterOfDay = [];
  for (const d of days) {
    const ts = runDay(byDay[d], P);
    ts.forEach((t, i) => {
      const m = mins(t.t);
      const b = BUCKETS.find(([, lo, hi]) => m >= lo && m < hi);
      if (b) orbByBucket.get(b[0]).push(t.points);
      (i === 0 ? firstOfDay : laterOfDay).push(t.points);
    });
  }

  console.log('=== ORB trades by time of day (12 months) ===');
  console.log('window         trades   win%       points        rupees     avg/trade');
  for (const [label] of BUCKETS) {
    const pts = orbByBucket.get(label);
    if (!pts.length) continue;
    const w = pts.filter((x) => x > 0).length;
    console.log(
      `  ${label}  ${String(pts.length).padStart(5)}   ${String(Math.round((w / pts.length) * 100)).padStart(3)}%  ` +
        sum(pts).toFixed(0).padStart(9) + '   ' + R(sum(pts)).padStart(12) + '   ' +
        (sum(pts) / pts.length).toFixed(1).padStart(6) + ' pts'
    );
  }

  console.log('\n=== first breakout of the day vs the ones after it ===');
  for (const [label, pts] of [['FIRST of day', firstOfDay], ['LATER in day', laterOfDay]]) {
    const w = pts.filter((x) => x > 0).length;
    console.log(
      `  ${label}  ${String(pts.length).padStart(4)} trades  ${String(Math.round((w / pts.length) * 100)).padStart(3)}% win  ` +
        R(sum(pts)).padStart(12) + `   avg ${(sum(pts) / pts.length).toFixed(1)} pts`
    );
  }

  // ---------- 2. NULL: random entries inside the same windows ----------
  // If a random coin-flip entry in the 09:45-10:15 window does as well as the
  // ORB breakout there, then the window is carrying the result and the signal
  // is contributing nothing.
  console.log('\n=== NULL TEST: random entry, same windows, same exits (20 runs) ===');
  console.log('window         ORB rupees    random median   random best   ORB beat random in');

  // Built once and reused by every bucket and every run — see prepDay.
  const prepped = days.map((d) => prepDay(byDay[d], P)).filter(Boolean);

  for (const [label, lo, hi] of BUCKETS) {
    const orbPts = sum(orbByBucket.get(label));
    if (!orbByBucket.get(label).length) continue;

    // Candidate entry bars per day for THIS bucket, also once per bucket.
    const candidates = prepped.map((day) => ({
      day,
      idx: day.after.map((x, i) => (x.m >= lo && x.m < hi ? i : -1)).filter((i) => i >= 0),
    })).filter((c) => c.idx.length);

    const runs = [];
    for (let run = 0; run < 20; run++) {
      let total = 0;
      for (const { day, idx } of candidates) {
        const pick = idx[Math.floor(Math.random() * idx.length)];
        const r = tradeFrom(day.after, pick, Math.random() < 0.5 ? 1 : -1, day.orRange, P);
        if (r) total += r.points;
      }
      runs.push(total);
    }
    runs.sort((a, b) => a - b);
    const median = runs[10];
    const beat = runs.filter((r) => r < orbPts).length;
    console.log(
      `  ${label}  ${R(orbPts).padStart(12)}   ${R(median).padStart(13)}   ${R(runs[19]).padStart(11)}   ${beat}/20`
    );
  }

  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
