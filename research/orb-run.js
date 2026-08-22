'use strict';
const { loadHistory, backtest, istDate, RUPEES_PER_POINT } = require('./orb-backtest');

const BASE = {
  orMinutes: 30, buffer: 0, maxTrades: 1,
  stopMode: 'range', stopFactor: 0.5, stopPoints: 60,
  trailMode: 'range', trailFactor: 0.5, trailPoints: 40,
  armPoints: 20, maxHoldBars: 0,
  entryCutoff: 14 * 60 + 45, squareOff: 15 * 60 + 15,
  minRangePoints: 0, maxRangePoints: 0,
};
const R = (pts) => 'Rs.' + (pts * RUPEES_PER_POINT).toFixed(0);

(async () => {
  console.log('Loading BANKNIFTY 5-min history...');
  const candles = await loadHistory(12);
  const byDay = {};
  for (const c of candles) { const d = istDate(new Date(c[0]).getTime()); (byDay[d] = byDay[d] || []).push(c); }
  const days = Object.keys(byDay).sort();
  console.log(`\n${candles.length} candles, ${days.length} trading days: ${days[0]} .. ${days[days.length - 1]}\n`);

  const r = backtest(byDay, BASE);
  console.log('=== BASELINE (30-min OR, 1 trade/day, stop 0.5x range, trail 0.5x range) ===');
  console.log(`  trades ${r.n}   wins ${r.w} (${((r.w / r.n) * 100).toFixed(0)}%)   ${r.pts.toFixed(0)} pts = ${R(r.pts)}`);
  console.log(`  avg/trade ${(r.pts / r.n).toFixed(1)} pts = ${R(r.pts / r.n)}   exits: ${Object.entries(r.why).map(([k, v]) => k + ':' + v).join(' ')}`);

  console.log('\n=== SWEEP: opening range length ===');
  console.log('  OR min   trades  wins   win%      points        rupees   avg/trade');
  for (const orMinutes of [15, 30, 45, 60, 90]) {
    const x = backtest(byDay, { ...BASE, orMinutes });
    if (!x.n) { console.log(`  ${orMinutes}`.padEnd(11) + '0'); continue; }
    console.log(`  ${String(orMinutes).padStart(4)}     ${String(x.n).padStart(5)}  ${String(x.w).padStart(4)}  ${((x.w / x.n) * 100).toFixed(0).padStart(4)}%  ${x.pts.toFixed(0).padStart(8)}  ${R(x.pts).padStart(12)}  ${(x.pts / x.n).toFixed(1).padStart(7)} pts`);
  }

  console.log('\n=== SWEEP: breakout buffer (how far past the range) ===');
  console.log('  buffer   trades  wins   win%      points        rupees');
  for (const buffer of [0, 10, 20, 30, 50]) {
    const x = backtest(byDay, { ...BASE, buffer });
    if (!x.n) continue;
    console.log(`  ${String(buffer).padStart(4)}     ${String(x.n).padStart(5)}  ${String(x.w).padStart(4)}  ${((x.w / x.n) * 100).toFixed(0).padStart(4)}%  ${x.pts.toFixed(0).padStart(8)}  ${R(x.pts).padStart(12)}`);
  }

  console.log('\n=== SWEEP: stop distance (x opening range) ===');
  console.log('  stop     trades  wins   win%      points        rupees');
  for (const stopFactor of [0.25, 0.5, 0.75, 1.0, 1.5]) {
    const x = backtest(byDay, { ...BASE, stopFactor });
    if (!x.n) continue;
    console.log(`  ${String(stopFactor).padStart(4)}x    ${String(x.n).padStart(5)}  ${String(x.w).padStart(4)}  ${((x.w / x.n) * 100).toFixed(0).padStart(4)}%  ${x.pts.toFixed(0).padStart(8)}  ${R(x.pts).padStart(12)}`);
  }

  console.log('\n=== SWEEP: trail distance (x opening range) ===');
  console.log('  trail    trades  wins   win%      points        rupees');
  for (const trailFactor of [0.25, 0.5, 0.75, 1.0, 0]) {
    const x = backtest(byDay, { ...BASE, trailFactor, trailMode: trailFactor ? 'range' : 'none' });
    if (!x.n) continue;
    console.log(`  ${String(trailFactor || 'off').padStart(4)}${trailFactor ? 'x' : ' '}   ${String(x.n).padStart(5)}  ${String(x.w).padStart(4)}  ${((x.w / x.n) * 100).toFixed(0).padStart(4)}%  ${x.pts.toFixed(0).padStart(8)}  ${R(x.pts).padStart(12)}`);
  }

  console.log('\n=== SWEEP: trades allowed per day ===');
  console.log('  max/day  trades  wins   win%      points        rupees');
  for (const maxTrades of [1, 2, 3]) {
    const x = backtest(byDay, { ...BASE, maxTrades });
    console.log(`  ${String(maxTrades).padStart(4)}     ${String(x.n).padStart(5)}  ${String(x.w).padStart(4)}  ${((x.w / x.n) * 100).toFixed(0).padStart(4)}%  ${x.pts.toFixed(0).padStart(8)}  ${R(x.pts).padStart(12)}`);
  }
})();
