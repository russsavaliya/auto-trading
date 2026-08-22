'use strict';
/** Pine-equivalent indicator maths, shared by the research scripts. */
const ema = (s, n) => { const k = 2 / (n + 1), o = []; let p = null;
  for (let i = 0; i < s.length; i++) { if (i < n - 1) { o.push(null); continue; }
    if (p === null) { let t = 0; for (let j = 0; j < n; j++) t += s[j]; p = t / n; } else p = s[i] * k + p * (1 - k); o.push(p); } return o; };
const rma = (s, n) => { const o = []; let p = null;
  for (let i = 0; i < s.length; i++) { if (i < n - 1) { o.push(null); continue; }
    if (p === null) { let t = 0; for (let j = 0; j <= i; j++) t += s[j]; p = t / (i + 1); } else p = (p * (n - 1) + s[i]) / n; o.push(p); } return o; };
const rsi = (c, n) => { const u = [0], d = [0];
  for (let i = 1; i < c.length; i++) { const x = c[i] - c[i - 1]; u.push(Math.max(x, 0)); d.push(Math.max(-x, 0)); }
  const ru = rma(u, n), rd = rma(d, n);
  return c.map((_, i) => (ru[i] == null || rd[i] == null) ? null : (rd[i] === 0 ? 100 : 100 - 100 / (1 + ru[i] / rd[i]))); };
const macd = (c) => { const f = ema(c, 12), s = ema(c, 26);
  const line = c.map((_, i) => (f[i] == null || s[i] == null) ? null : f[i] - s[i]);
  const v = line.filter(x => x != null), sig = ema(v, 9), off = line.length - v.length;
  return { line, signal: line.map((_, i) => i < off ? null : sig[i - off]) }; };
function supertrend(h, l, c, f, n) {
  const tr = c.map((_, i) => i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  const atr = rma(tr, n), dir = []; let pu = null, pl = null, ps = null;
  for (let i = 0; i < c.length; i++) {
    if (atr[i] == null) { dir.push(null); continue; }
    const m = (h[i] + l[i]) / 2; let up = m + f * atr[i], lo = m - f * atr[i];
    if (pu !== null) up = (up < pu || c[i - 1] > pu) ? up : pu;
    if (pl !== null) lo = (lo > pl || c[i - 1] < pl) ? lo : pl;
    let d; if (ps === null) d = 1; else if (ps === pu) d = c[i] > up ? -1 : 1; else d = c[i] < lo ? 1 : -1;
    ps = d === -1 ? lo : up; pu = up; pl = lo; dir.push(d);
  } return dir;
}
module.exports = { ema, rma, rsi, macd, supertrend };
