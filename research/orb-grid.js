'use strict';
const { loadHistory, backtest, istDate, RUPEES_PER_POINT } = require('./orb-backtest');
const R = (p) => (p * RUPEES_PER_POINT / 1000).toFixed(0) + 'k';
const BASE = {
  orMinutes: 30, buffer: 0, maxTrades: 1,
  stopMode: 'range', stopFactor: 0.5, stopPoints: 60,
  trailMode: 'range', trailFactor: 0.5, trailPoints: 40,
  armPoints: 20, maxHoldBars: 0,
  entryCutoff: 14 * 60 + 45, squareOff: 15 * 60 + 15,
  minRangePoints: 0, maxRangePoints: 0,
};
(async () => {
  const candles = await loadHistory(12);
  const byDay = {};
  for (const c of candles) { const d = istDate(new Date(c[0]).getTime()); (byDay[d] = byDay[d] || []).push(c); }

  console.log('\n=== 2D GRID: stop (rows) x trail (cols), rupees, 1 trade/day ===');
  console.log('        trail: 0.25x   0.5x   0.75x   1.0x   1.5x    OFF');
  for (const stopFactor of [0.25, 0.5, 0.75, 1.0, 1.5]) {
    let row = '  stop ' + String(stopFactor) + 'x  ';
    for (const tf of [0.25, 0.5, 0.75, 1.0, 1.5, null]) {
      const x = backtest(byDay, { ...BASE, stopFactor, trailFactor: tf, trailMode: tf === null ? 'none' : 'range' });
      row += R(x.pts).padStart(7);
    }
    console.log(row);
  }

  console.log('\n=== expectancy detail for a few cells ===');
  console.log('  stop  trail   trades  win%   avg win   avg loss   expectancy');
  for (const [sf, tf] of [[0.5, 0.5], [0.5, 1.0], [1.0, 1.0], [0.25, 0.25], [1.0, null]]) {
    const p = { ...BASE, stopFactor: sf, trailFactor: tf, trailMode: tf === null ? 'none' : 'range' };
    let wins = [], losses = [];
    const { runDay } = require('./orb-backtest');
    for (const d of Object.keys(byDay).sort()) for (const t of runDay(byDay[d], p)) (t.points > 0 ? wins : losses).push(t.points);
    const n = wins.length + losses.length;
    const aw = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
    const al = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
    const exp = (wins.reduce((a, b) => a + b, 0) + losses.reduce((a, b) => a + b, 0)) / n;
    console.log('  ' + String(sf) + 'x  ' + String(tf === null ? 'off' : tf + 'x').padEnd(6) + String(n).padStart(6) + '  ' + ((wins.length / n) * 100).toFixed(0).padStart(4) + '%  ' + aw.toFixed(1).padStart(8) + '  ' + al.toFixed(1).padStart(9) + '   ' + exp.toFixed(2).padStart(7) + ' pts');
  }

  console.log('\n=== does the opening-range SIZE matter? (stop 1.0x, trail 1.0x) ===');
  console.log('  OR range filter        trades  win%     rupees');
  for (const [lo, hi, lbl] of [[0, 0, 'all days'], [0, 100, 'narrow  <100 pts'], [100, 200, 'medium 100-200'], [200, 0, 'wide    >200 pts']]) {
    const x = backtest(byDay, { ...BASE, stopFactor: 1.0, trailFactor: 1.0, minRangePoints: lo, maxRangePoints: hi });
    if (!x.n) { console.log('  ' + lbl.padEnd(22) + '0'); continue; }
    console.log('  ' + lbl.padEnd(22) + String(x.n).padStart(5) + '  ' + ((x.w / x.n) * 100).toFixed(0).padStart(4) + '%  ' + R(x.pts).padStart(9));
  }
})();
