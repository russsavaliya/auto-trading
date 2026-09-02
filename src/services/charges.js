'use strict';

/**
 * What a round trip actually costs.
 *
 * WHY THIS EXISTS
 * Until now every figure on this dashboard was a GROSS premium difference.
 * On BANKNIFTY options the friction is not a rounding error: at 30 quantity
 * and a ~600 premium a round trip costs roughly Rs.94 before the position has
 * moved at all. Against a strategy whose measured expectancy is around
 * -Rs.155/trade (see config/env.js), costs are a material part of the answer,
 * not a footnote — a "small winner" of +Rs.60 gross is really a loss.
 *
 * RATES ARE A SINGLE BLOCK ON PURPOSE
 * Statutory rates change (STT on option sales went 0.0625% -> 0.1% in Oct
 * 2024, and exchange transaction charges were re-cut at the same time). The
 * one thing that must never happen is a rate living in two places and drifting.
 * So every number is named here, with what it applies to, and nothing below
 * hard-codes a percentage.
 *
 * VERIFY THESE AGAINST A REAL CONTRACT NOTE before trusting the Report page to
 * the rupee. They are the published NSE/Upstox equity-options rates, but a
 * broker plan or a budget change can move any of them, and this file is
 * deliberately the only place that has to be edited when one does. The Report
 * page renders these same values, so a stale rate is visible rather than
 * silently baked into a total.
 */

/**
 * Every rate charged on an NSE equity-options round trip.
 *
 * `pct` values are fractions of PREMIUM TURNOVER (premium x quantity), not of
 * notional — options are charged on premium, and using notional here would
 * overstate every cost by a factor of ~90.
 */
const RATES = {
  /** Flat, per executed order. Upstox F&O is Rs.20/order irrespective of size. */
  brokeragePerOrder: 20,

  /**
   * Per-order platform/API fee. NOT a standard Upstox charge — this is the
   * Rs.10 configured for this account. Kept as its own line so it can be
   * zeroed without touching any statutory rate.
   */
  apiFeePerOrder: 10,

  /** STT — SELL side only, on premium. 0.1% since 1 Oct 2024 (was 0.0625%). */
  sttSellPct: 0.001,

  /** NSE exchange transaction charge — both legs. Rs.3,503 per crore. */
  exchangeTxnPct: 0.0003503,

  /** SEBI turnover fee — both legs. Rs.10 per crore. */
  sebiPerCrore: 10,

  /** NSE Investor Protection Fund Trust levy — both legs. Rs.50 per crore. */
  ipftPerCrore: 50,

  /** GST on the SERVICE component only — never on STT or stamp duty. */
  gstPct: 0.18,

  /** Stamp duty — BUY side only. 0.003% (Rs.300 per crore). */
  stampDutyBuyPct: 0.00003,
};

/** Rs. per crore -> plain fraction of turnover. */
const perCrore = (rs) => rs / 1e7;

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Charges for one completed round trip (one BUY leg + one SELL leg).
 *
 * Both premiums are PER UNIT, exactly as `trades.entry_price` / `exit_price`
 * store them — turnover is derived here so no caller can forget the quantity.
 *
 * Returns null when either leg is unpriced. An unpriced trade already has a
 * null P&L (tradeExecutor refuses to invent one), and inventing a charge for
 * it would put a number in the "total costs" column that no contract note
 * would ever show. The Report page counts those trades separately instead.
 */
function computeRoundTrip({ entryPremium, exitPremium, quantity }) {
  const entry = Number(entryPremium);
  const exit = Number(exitPremium);
  const qty = Number(quantity);
  if (![entry, exit, qty].every(Number.isFinite) || qty <= 0) return null;

  const buyTurnover = entry * qty;
  const sellTurnover = exit * qty;
  const turnover = buyTurnover + sellTurnover;

  const brokerage = RATES.brokeragePerOrder * 2;
  const apiFee = RATES.apiFeePerOrder * 2;
  const exchangeTxn = turnover * RATES.exchangeTxnPct;
  const sebi = turnover * perCrore(RATES.sebiPerCrore);
  const ipft = turnover * perCrore(RATES.ipftPerCrore);

  // GST applies to the broker's and exchange's SERVICE fees. STT and stamp
  // duty are taxes in their own right and are never part of the GST base —
  // taxing them would be taxing a tax.
  const gst = (brokerage + apiFee + exchangeTxn + sebi + ipft) * RATES.gstPct;

  const stt = sellTurnover * RATES.sttSellPct;
  const stampDuty = buyTurnover * RATES.stampDutyBuyPct;

  const components = { brokerage, apiFee, stt, exchangeTxn, sebi, ipft, gst, stampDuty };
  const total = Object.values(components).reduce((s, v) => s + v, 0);

  return {
    ...Object.fromEntries(Object.entries(components).map(([k, v]) => [k, round2(v)])),
    total: round2(total),
    buyTurnover: round2(buyTurnover),
    sellTurnover: round2(sellTurnover),
  };
}

/**
 * Gross P&L minus what it cost to earn it.
 *
 * `grossPnl` is the premium difference already stored on the trade. Kept as a
 * separate step from computeRoundTrip so the two can be shown side by side —
 * the whole point of the Report page is that the reader sees the gap.
 */
function applyToPnl(grossPnl, chargesTotal) {
  if (grossPnl == null || chargesTotal == null) return null;
  return round2(Number(grossPnl) - Number(chargesTotal));
}

/**
 * The rate card, for display. The Report page renders this so the numbers
 * above it can be checked against a contract note without reading the source.
 */
function rateCard() {
  return {
    brokeragePerOrder: RATES.brokeragePerOrder,
    apiFeePerOrder: RATES.apiFeePerOrder,
    sttSellPct: RATES.sttSellPct,
    exchangeTxnPct: RATES.exchangeTxnPct,
    sebiPerCrore: RATES.sebiPerCrore,
    ipftPerCrore: RATES.ipftPerCrore,
    gstPct: RATES.gstPct,
    stampDutyBuyPct: RATES.stampDutyBuyPct,
  };
}

module.exports = { computeRoundTrip, applyToPnl, rateCard, RATES };
