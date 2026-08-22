'use strict';
const { ema, rsi, macd, supertrend } = require('./indicators');
const { loadHistory, istDate, istHHMM, mins, RUPEES_PER_POINT } = require('./orb-backtest');
const COST = 2.5;
const R = (p) => 'Rs.' + (p * RUPEES_PER_POINT).toFixed(0);

(async () => {
  const candles = await loadHistory(12);
  const c = candles.map(x=>+x[4]), h = candles.map(x=>+x[2]), l = candles.map(x=>+x[3]);
  const hlc3 = candles.map(x=>(+x[2]+ +x[3]+ +x[4])/3);
  const day = candles.map(x=>istDate(new Date(x[0]).getTime()));
  const hhmm = candles.map(x=>istHHMM(new Date(x[0]).getTime()));
  const vwap=[]; let a=0,n=0;
  for(let i=0;i<candles.length;i++){ if(i===0||day[i]!==day[i-1]){a=0;n=0;} a+=hlc3[i];n++;vwap.push(a/n); }
  const e9=ema(c,9), e21=ema(c,21), r=rsi(c,14), m=macd(c), st=supertrend(h,l,c,2.0,10);
  const dH=c.map((_,i)=>i<21?null:Math.max(...h.slice(i-20,i)));
  const dL=c.map((_,i)=>i<21?null:Math.min(...l.slice(i-20,i)));
  const er=c.map((_,i)=>{if(i<10)return null;let p=0;for(let k=i-9;k<=i;k++)p+=Math.abs(c[k]-c[k-1]);return p>0?Math.abs(c[i]-c[i-10])/p:0;});
  const v1=c.map((_,i)=>[e9[i],e21[i],r[i],m.line[i],m.signal[i],st[i]].some(x=>x==null)?null:
    (e9[i]>e21[i]?1:-1)+(c[i]>e21[i]?1:-1)+(st[i]<0?1:-1)+(r[i]>55?1:r[i]<45?-1:0)+(m.line[i]>m.signal[i]?1:-1));
  const v2=c.map((_,i)=>{ if([r[i],m.line[i],m.signal[i],st[i],dH[i],dL[i]].some(x=>x==null))return null;
    const vd=(c[i]-vwap[i])/vwap[i]*100;
    return (st[i]<0?1:-1)+(vd>0.05?1:vd<-0.05?-1:0)+(c[i]>dH[i]?1:c[i]<dL[i]?-1:0)+(r[i]>55?1:r[i]<45?-1:0)+(m.line[i]>m.signal[i]?1:-1); });

  function sim(score, thr, useEr, erMin, maxPerDay, dayFilter){
    let pts=0,cnt=0,win=0, lastDay=null, took=0;
    for(let i=30;i<c.length-2;i++){
      if(day[i]!==lastDay){lastDay=day[i];took=0;}
      if(dayFilter && !dayFilter(day[i])) continue;
      if(score[i]==null||took>=maxPerDay) continue;
      if(mins(hhmm[i])+5>=14*60+45) continue;
      if(useEr&&(er[i]==null||er[i]<erMin)) continue;
      const dir = score[i]>=thr?1:score[i]<=-thr?-1:0; if(!dir) continue;
      const prev=score[i-1]; if(prev!=null&&(dir===1?prev>=thr:prev<=-thr)) continue;
      took++;
      const entry=c[i]+dir*COST;
      // stop 60 pts, trail 120 pts armed at +20, EOD square-off (same family as ORB test)
      let best=entry, exit=null;
      for(let j=i+1;j<c.length;j++){
        if(day[j]!==day[i]){exit=c[j-1];break;}
        const st_= dir===1?entry-60:entry+60;
        if(dir===1?l[j]<=st_:h[j]>=st_){exit=st_;break;}
        const armed = dir===1?best>=entry+20:best<=entry-20;
        if(armed){const tr=dir===1?best-120:best+120; if(dir===1?l[j]<=tr:h[j]>=tr){exit=tr;break;}}
        best = dir===1?Math.max(best,h[j]):Math.min(best,l[j]);
        if(mins(hhmm[j])+5>=15*60+15){exit=c[j];break;}
      }
      if(exit==null) continue;
      const g=(dir===1?exit-entry:entry-exit)-COST;
      pts+=g;cnt++;if(g>0)win++;
    }
    return {pts,cnt,win};
  }

  const days=[...new Set(day)].sort();
  const mid=days[Math.floor(days.length/2)];
  const H1=(d)=>d<mid, H2=(d)=>d>=mid;

  console.log('\nFULL TRADE SIM — 1 signal/day, stop 60pts, trail 120pts, EOD square-off\n');
  console.log('  variant                              period      trades win%      P&L');
  console.log('  '+'-'.repeat(70));
  for(const [lbl,sc,thr,ue,em] of [
    ['v1 (>=4, no ER)',            v1,4,false,0],
    ['v2 (>=3, ER 0.30) as shipped',v2,3,true,0.30],
    ['v2 (>=3, no ER)',            v2,3,false,0],
    ['v2 (>=4, no ER)',            v2,4,false,0],
  ]){
    for(const [pl,f] of [['ALL      ',null],['1st half ',H1],['2nd half ',H2]]){
      const x=sim(sc,thr,ue,em,1,f);
      console.log('  '+lbl.padEnd(36)+pl+String(x.cnt).padStart(5)+'  '+(x.cnt?((x.win/x.cnt)*100).toFixed(0):'0').padStart(3)+'%  '+R(x.pts).padStart(10));
    }
    console.log('');
  }
})();
