'use strict';
const { loadHistory, runDay, backtest, istDate, istHHMM, mins, RUPEES_PER_POINT } = require('./orb-backtest');
const R = (p) => (p * RUPEES_PER_POINT / 1000).toFixed(0) + 'k';
const P = { orMinutes:30, buffer:0, maxTrades:1, stopMode:'range', stopFactor:0.5, stopPoints:60,
  trailMode:'range', trailFactor:1.0, trailPoints:40, armPoints:20, maxHoldBars:0,
  entryCutoff:14*60+45, squareOff:15*60+15, minRangePoints:0, maxRangePoints:0 };

(async () => {
  const candles = await loadHistory(12);
  const byDay = {};
  for (const c of candles) { const d = istDate(new Date(c[0]).getTime()); (byDay[d] = byDay[d] || []).push(c); }
  const days = Object.keys(byDay).sort();

  // ---- 1. is it just market drift? ----
  const first = +byDay[days[0]][0][1], last = +byDay[days[days.length-1]].slice(-1)[0][4];
  console.log('\n=== TEST 1: is the market itself trending? ===');
  console.log(`  BANKNIFTY ${days[0]} ${first.toFixed(0)}  ->  ${days[days.length-1]} ${last.toFixed(0)}   = ${(last-first>0?'+':'')}${(last-first).toFixed(0)} pts over ${days.length} days`);
  let L=[], S=[];
  for (const d of days) for (const t of runDay(byDay[d], P)) (t.dir===1?L:S).push(t.points);
  const sum=(a)=>a.reduce((x,y)=>x+y,0);
  console.log(`  LONG  trades ${String(L.length).padStart(3)}  wins ${String(L.filter(x=>x>0).length).padStart(3)} (${((L.filter(x=>x>0).length/L.length)*100).toFixed(0)}%)   ${R(sum(L)).padStart(6)}`);
  console.log(`  SHORT trades ${String(S.length).padStart(3)}  wins ${String(S.filter(x=>x>0).length).padStart(3)} (${((S.filter(x=>x>0).length/S.length)*100).toFixed(0)}%)   ${R(sum(S)).padStart(6)}`);
  console.log(`  -> ${sum(L)>0&&sum(S)>0 ? 'BOTH sides profitable — not just drift' : 'one side carries it — likely drift/beta'}`);

  // ---- 2. out of sample: split in half ----
  console.log('\n=== TEST 2: first half vs second half (out-of-sample) ===');
  const mid = Math.floor(days.length/2);
  for (const [lbl, ds] of [['first  half', days.slice(0,mid)], ['second half', days.slice(mid)]]) {
    const sub={}; ds.forEach(d=>sub[d]=byDay[d]);
    const x = backtest(sub, P);
    console.log(`  ${lbl}  ${ds[0]} .. ${ds[ds.length-1]}   trades ${String(x.n).padStart(3)}  win ${((x.w/x.n)*100).toFixed(0)}%   ${R(x.pts).padStart(6)}   avg ${(x.pts/x.n).toFixed(1)} pts`);
  }

  // ---- 3. NULL TEST: same exits, random entry time & direction ----
  console.log('\n=== TEST 3: NULL — same exit rules, RANDOM entry (does the ORB signal matter?) ===');
  let seed = 12345;
  const rnd = () => { seed = (seed*1103515245+12345) & 0x7fffffff; return seed/0x7fffffff; };
  const runs=[];
  for (let iter=0; iter<20; iter++) {
    let pts=0,n=0,w=0;
    for (const d of days) {
      const bars = byDay[d].filter(b=>mins(istHHMM(new Date(b[0]).getTime()))>=555);
      if (bars.length<20) continue;
      const orBars = bars.filter(b=>mins(istHHMM(new Date(b[0]).getTime()))<555+P.orMinutes);
      const orRange = Math.max(...orBars.map(b=>+b[2])) - Math.min(...orBars.map(b=>+b[3]));
      const after = bars.filter(b=>mins(istHHMM(new Date(b[0]).getTime()))>=555+P.orMinutes);
      if (after.length<5) continue;
      const k = Math.floor(rnd()*Math.max(1,after.length-5));
      const dir = rnd()>0.5?1:-1;
      const entry = +after[k][4] + dir*2.5;
      const stopD = orRange*P.stopFactor, trailD = orRange*P.trailFactor;
      let best=entry, exit=null;
      for (let j=k+1;j<after.length;j++){
        const b=after[j], hi=+b[2], lo=+b[3], cl=+b[4];
        const m=mins(istHHMM(new Date(b[0]).getTime()));
        const st = dir===1?entry-stopD:entry+stopD;
        if (dir===1?lo<=st:hi>=st){exit=st;break;}
        const armed = dir===1?best>=entry+P.armPoints:best<=entry-P.armPoints;
        if (armed){ const tr = dir===1?best-trailD:best+trailD; if(dir===1?lo<=tr:hi>=tr){exit=tr;break;} }
        best = dir===1?Math.max(best,hi):Math.min(best,lo);
        if (m+5>=P.squareOff||j===after.length-1){exit=cl;break;}
      }
      if(exit===null)continue;
      const g=(dir===1?exit-entry:entry-exit)-2.5;
      pts+=g;n++;if(g>0)w++;
    }
    runs.push(pts);
  }
  runs.sort((a,b)=>a-b);
  const real = backtest(byDay, P).pts;
  const better = runs.filter(r=>r>=real).length;
  console.log(`  random-entry runs (20):  worst ${R(runs[0])}   median ${R(runs[10])}   best ${R(runs[19])}`);
  console.log(`  ORB signal:              ${R(real)}`);
  console.log(`  random runs that beat ORB: ${better}/20`);
  console.log(`  -> ${better<=1 ? 'ORB entry ADDS something beyond the exit rules' : 'the EXIT rules are doing the work, not the ORB entry'}`);
})();
