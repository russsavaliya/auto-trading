'use strict';
// Rebuilds the Pine score in JS from Upstox 5-minute BANKNIFTY candles and
// checks it against the `score` field TradingView actually sent, bar for bar.
// If these agree, the indicator can be backtested over months instead of the
// 37 live trades every conclusion currently rests on.

require('dotenv').config();
const { supabase } = require('../src/services/supabaseService');
const mc = require('../src/utils/marketClock');
const axios = require('axios');

const KEY = encodeURIComponent('NSE_INDEX|Nifty Bank');

async function fetch5m(from, to) {
  // Upstox v3 orders the path as .../{unit}/{interval}/{TO_DATE}/{FROM_DATE}.
  // Passing them the other way round returns 400. Single-day calls elsewhere in
  // this repo pass the same date twice, which hides the ordering.
  const url = `https://api.upstox.com/v3/historical-candle/${KEY}/minutes/5/${to}/${from}`;
  const r = await axios.get(url, { timeout: 30000, headers: { Accept: 'application/json' } });
  return (r.data?.data?.candles || []).slice().sort((a, b) => new Date(a[0]) - new Date(b[0]));
}
async function fetch5mIntraday() {
  const url = `https://api.upstox.com/v3/historical-candle/intraday/${KEY}/minutes/5`;
  const r = await axios.get(url, { timeout: 30000, headers: { Accept: 'application/json' } });
  return (r.data?.data?.candles || []).slice().sort((a, b) => new Date(a[0]) - new Date(b[0]));
}

// --- indicators, matching Pine semantics exactly ---
function ema(src, len) {
  const k = 2 / (len + 1), out = [];
  let prev = null;
  for (let i = 0; i < src.length; i++) {
    // Pine seeds ta.ema with an SMA of the first `len` values.
    if (i < len - 1) { out.push(null); continue; }
    if (prev === null) {
      let s = 0; for (let j = 0; j < len; j++) s += src[j];
      prev = s / len;
    } else prev = src[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}
function rma(src, len) {                       // Wilder smoothing (Pine ta.rma)
  const out = []; let prev = null;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === null) { out.push(null); continue; }
    if (i < len - 1) { out.push(null); continue; }
    if (prev === null) {
      let s = 0; for (let j = 0; j <= i; j++) s += src[j];
      prev = s / (i + 1);
    } else prev = (prev * (len - 1) + src[i]) / len;
    out.push(prev);
  }
  return out;
}
function rsi(close, len) {
  const up = [0], dn = [0];
  for (let i = 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    up.push(Math.max(d, 0)); dn.push(Math.max(-d, 0));
  }
  const ru = rma(up, len), rd = rma(dn, len);
  return close.map((_, i) => (ru[i] === null || rd[i] === null) ? null : (rd[i] === 0 ? 100 : 100 - 100 / (1 + ru[i] / rd[i])));
}
function macd(close) {
  const f = ema(close, 12), s = ema(close, 26);
  const line = close.map((_, i) => (f[i] === null || s[i] === null) ? null : f[i] - s[i]);
  const valid = line.filter((v) => v !== null);
  const sig = ema(valid, 9);
  const off = line.length - valid.length;
  const signal = line.map((_, i) => (i < off ? null : sig[i - off]));
  return { line, signal };
}
function supertrend(high, low, close, factor, atrLen) {
  const tr = close.map((_, i) => i === 0 ? high[i] - low[i]
    : Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])));
  const atr = rma(tr, atrLen);
  const dir = [], st = [];
  let pUp = null, pLo = null, pSt = null, pDir = null;
  for (let i = 0; i < close.length; i++) {
    if (atr[i] === null) { dir.push(null); st.push(null); continue; }
    const hl2 = (high[i] + low[i]) / 2;
    let up = hl2 + factor * atr[i], lo = hl2 - factor * atr[i];
    if (pUp !== null) up = (up < pUp || close[i - 1] > pUp) ? up : pUp;
    if (pLo !== null) lo = (lo > pLo || close[i - 1] < pLo) ? lo : pLo;
    let d;
    if (pSt === null) d = 1;
    else if (pSt === pUp) d = close[i] > up ? -1 : 1;
    else d = close[i] < lo ? 1 : -1;
    const cur = d === -1 ? lo : up;
    dir.push(d); st.push(cur);
    pUp = up; pLo = lo; pSt = cur; pDir = d;
  }
  return dir;
}

(async () => {
  // Warm-up matters: EMA21/MACD26/RSI14 need history, and Pine computes
  // continuously across days on an NSE chart, so the series must be continuous.
  const hist = await fetch5m('2026-07-20', '2026-08-13');
  const today = await fetch5mIntraday();
  const seen = new Set(hist.map((c) => c[0]));
  const cs = hist.concat(today.filter((c) => !seen.has(c[0])));
  console.log(`5-min bars loaded: ${cs.length}  (${cs[0][0].slice(0, 16)} -> ${cs[cs.length - 1][0].slice(0, 16)})`);

  const close = cs.map((c) => +c[4]), high = cs.map((c) => +c[2]), low = cs.map((c) => +c[3]);
  const e9 = ema(close, 9), e21 = ema(close, 21);
  const r = rsi(close, 14);
  const m = macd(close);
  const stDir = supertrend(high, low, close, 2.0, 10);

  const score = close.map((_, i) => {
    if ([e9[i], e21[i], r[i], m.line[i], m.signal[i], stDir[i]].some((v) => v === null)) return null;
    let t = 0;
    t += e9[i] > e21[i] ? 1 : -1;
    t += close[i] > e21[i] ? 1 : -1;
    t += stDir[i] < 0 ? 1 : -1;
    let mo = 0;
    mo += r[i] > 55 ? 1 : r[i] < 45 ? -1 : 0;
    mo += m.line[i] > m.signal[i] ? 1 : -1;
    return t + mo;
  });

  const byTime = new Map(cs.map((c, i) => [new Date(c[0]).getTime(), i]));

  const { data: w } = await supabase.from('webhook_log').select('*').order('received_at');
  const alerts = w.filter((x) => x.raw_payload?.score !== undefined);
  console.log(`\nalerts with a score to check: ${alerts.length}\n`);
  console.log('alert time (IST)   TV score   my score   match   bar');
  console.log('-'.repeat(62));

  let match = 0, checked = 0, off1 = 0; const perDay = {};
  const misses = [];
  for (const a of alerts) {
    const p = a.raw_payload;
    // The alert fires at bar CLOSE, so the bar it describes STARTED 5 min earlier.
    const barStart = Number(p.timestamp);
    const i = byTime.get(barStart);
    if (i === undefined || score[i] === null) continue;
    checked++;
    const ok = score[i] === Number(p.score);
    if (ok) match++;
    else if (Math.abs(score[i] - Number(p.score)) === 1) off1++;

    // Split by day: the script changed on 12 Aug (volume component switched
    // off), so pre- and post-change alerts must be judged separately.
    const dk = mc.istDate(barStart);
    perDay[dk] = perDay[dk] || { n: 0, ok: 0, diffs: [] };
    perDay[dk].n++;
    if (ok) perDay[dk].ok++;
    else perDay[dk].diffs.push(score[i] - Number(p.score));
    if (!ok && misses.length < 12) misses.push({ t: mc.istString(barStart).slice(5, 16), tv: p.score, mine: score[i] });
    if (checked <= 18) {
      console.log(mc.istString(barStart).slice(5, 16).padEnd(18) + String(p.score).padStart(6) + String(score[i]).padStart(11) + '     ' + (ok ? 'yes' : 'NO ') + '    ' + cs[i][0].slice(11, 16));
    }
  }
  console.log('-'.repeat(62));
  console.log(`\nchecked ${checked}   exact match ${match} (${((match / checked) * 100).toFixed(0)}%)   off-by-one ${off1}`);
  console.log('\nper trading day  (volume component was switched OFF on 12 Aug)');
  console.log('day           alerts  exact    difference seen (mine - TV)');
  console.log('-'.repeat(62));
  for (const d of Object.keys(perDay).sort()) {
    const v = perDay[d];
    const uniq = [...new Set(v.diffs)].sort((a, b) => a - b);
    console.log(
      d + '    ' + String(v.n).padStart(5) + '   ' + String(v.ok + '/' + v.n).padEnd(8) +
      (uniq.length ? uniq.join(', ') : 'all exact')
    );
  }
})();
