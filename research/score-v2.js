'use strict';
/**
 * Tests the v2 score (Supertrend + VWAP + Donchian + RSI + MACD) against 13
 * months of BANKNIFTY 5-min data, with v1 run through the identical harness as
 * a control. v1 is known-bad (profit factor 0.516 on TradingView's own data),
 * so if the harness says v1 is bad and v2 is good, that difference means
 * something. If it says both are bad, that means something too.
 *
 * VWAP CAVEAT: Upstox index candles carry volume 0 (verified: 0 of 20,337
 * candles have any), and TradingView's index volume is a synthetic aggregate of
 * constituents. A genuine volume-weighted average price does not exist for this
 * instrument from either source. What is computed here is the session-anchored
 * mean of hlc3 — which is exactly what VWAP degenerates to when volume carries
 * no information. That is the honest version of the same idea.
 */
const { loadHistory, istDate, istHHMM, mins } = require('./orb-backtest');
const { ema, rsi, macd, supertrend } = require('./indicators');

(async () => {
  const candles = await loadHistory(12);
  const c = candles.map(x => +x[4]), h = candles.map(x => +x[2]), l = candles.map(x => +x[3]);
  const hlc3 = candles.map(x => (+x[2] + +x[3] + +x[4]) / 3);
  const day = candles.map(x => istDate(new Date(x[0]).getTime()));
  const hhmm = candles.map(x => istHHMM(new Date(x[0]).getTime()));

  // session-anchored mean of hlc3 (see VWAP caveat above)
  const vwap = []; let acc = 0, cnt = 0;
  for (let i = 0; i < candles.length; i++) { if (i === 0 || day[i] !== day[i - 1]) { acc = 0; cnt = 0; } acc += hlc3[i]; cnt++; vwap.push(acc / cnt); }

  const e9 = ema(c, 9), e21 = ema(c, 21), r = rsi(c, 14), m = macd(c);
  const st = supertrend(h, l, c, 2.0, 10);
  const dHigh = c.map((_, i) => i < 21 ? null : Math.max(...h.slice(i - 20, i)));
  const dLow  = c.map((_, i) => i < 21 ? null : Math.min(...l.slice(i - 20, i)));
  const er = c.map((_, i) => { if (i < 10) return null; let p = 0; for (let k = i - 9; k <= i; k++) p += Math.abs(c[k] - c[k - 1]); return p > 0 ? Math.abs(c[i] - c[i - 10]) / p : 0; });

  const v1 = c.map((_, i) => { if ([e9[i], e21[i], r[i], m.line[i], m.signal[i], st[i]].some(x => x == null)) return null;
    let t = (e9[i] > e21[i] ? 1 : -1) + (c[i] > e21[i] ? 1 : -1) + (st[i] < 0 ? 1 : -1);
    let mo = (r[i] > 55 ? 1 : r[i] < 45 ? -1 : 0) + (m.line[i] > m.signal[i] ? 1 : -1); return t + mo; });

  const v2 = c.map((_, i) => { if ([r[i], m.line[i], m.signal[i], st[i], dHigh[i], dLow[i]].some(x => x == null)) return null;
    const trend = st[i] < 0 ? 1 : -1;
    const vd = (c[i] - vwap[i]) / vwap[i] * 100;
    const vw = vd > 0.05 ? 1 : vd < -0.05 ? -1 : 0;
    const bo = c[i] > dHigh[i] ? 1 : c[i] < dLow[i] ? -1 : 0;
    const rs = r[i] > 55 ? 1 : r[i] < 45 ? -1 : 0;
    const mc = m.line[i] > m.signal[i] ? 1 : -1;
    return trend + vw + bo + rs + mc; });

  /** Fixed-horizon forward move in the signalled direction — exit-independent. */
  function edgeTest(score, thr, useEr, erMin) {
    const H = [3, 6, 12]; // 15 / 30 / 60 min
    const out = H.map(() => ({ n: 0, good: 0, sum: 0 }));
    let signals = 0, lastDay = null, tookToday = 0;
    for (let i = 30; i < c.length - 13; i++) {
      if (day[i] !== lastDay) { lastDay = day[i]; tookToday = 0; }
      if (score[i] == null) continue;
      if (mins(hhmm[i]) + 5 >= 14 * 60 + 45) continue;
      if (useEr && (er[i] == null || er[i] < erMin)) continue;
      const dir = score[i] >= thr ? 1 : score[i] <= -thr ? -1 : 0;
      if (!dir) continue;
      // only count a fresh signal, and cap at 1/day so days are weighted equally
      const prev = score[i - 1];
      const wasOn = prev != null && (dir === 1 ? prev >= thr : prev <= -thr);
      if (wasOn) continue;
      if (tookToday >= 1) continue;
      tookToday++; signals++;
      H.forEach((hz, k) => { const j = i + hz; if (j >= c.length || day[j] !== day[i]) return;
        const mv = (c[j] - c[i]) * dir; out[k].n++; out[k].sum += mv; if (mv > 0) out[k].good++; });
    }
    return { signals, out, H };
  }

  console.log(`\n${candles.length} candles, ${new Set(day).size} trading days\n`);
  console.log('ENTRY EDGE — forward index move in the signalled direction (no exit rules at all)');
  console.log('a coin flip is ~50% and ~0 points. below that = the signal is anti-predictive.\n');
  console.log('  variant                          signals    +15m         +30m         +60m');
  console.log('  ' + '-'.repeat(74));
  for (const [lbl, sc, thr, useEr, erMin] of [
    ['v1 (score>=4, no ER filter)',      v1, 4, false, 0],
    ['v2 (score>=3, no ER filter)',      v2, 3, false, 0],
    ['v2 (score>=3, ER>=0.30) <- as shipped', v2, 3, true, 0.30],
    ['v2 (score>=4, ER>=0.30)',          v2, 4, true, 0.30],
    ['v2 (score>=4, no ER filter)',      v2, 4, false, 0],
  ]) {
    const x = edgeTest(sc, thr, useEr, erMin);
    let row = '  ' + lbl.padEnd(34) + String(x.signals).padStart(5) + '  ';
    x.out.forEach(o => { row += (o.n ? `${((o.good / o.n) * 100).toFixed(0)}% ${(o.sum / o.n >= 0 ? '+' : '') + (o.sum / o.n).toFixed(1)}pt` : '—').padStart(13); });
    console.log(row);
  }
})();

