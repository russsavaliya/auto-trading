'use strict';

const supabaseService = require('../services/supabaseService');
const marketClock = require('../utils/marketClock');
const charges = require('../services/charges');

async function getSummary(req, res, next) {
  try {
    const closedTrades = await supabaseService.getClosedTradesSince(null, req.mode);
    const runningTrades = await supabaseService.listRunningTrades(req.mode);

    // A trade whose premium could not be determined has pnl = null. It is
    // excluded from every figure below rather than silently counted as zero,
    // and surfaced as `unpricedTrades` so a gap in the data can never be
    // mistaken for a break-even result.
    const priced = closedTrades.filter((t) => t.pnl !== null && t.pnl !== undefined);
    const unpriced = closedTrades.length - priced.length;

    const totalPnl = priced.reduce((sum, t) => sum + Number(t.pnl), 0);
    const wins = priced.filter((t) => Number(t.pnl) > 0).length;
    const losses = priced.filter((t) => Number(t.pnl) < 0).length;

    const todayStart = new Date(`${marketClock.istDate()}T00:00:00+05:30`);
    const closedToday = priced.filter((t) => t.closed_at && new Date(t.closed_at) >= todayStart);
    const todayPnl = closedToday.reduce((sum, t) => sum + Number(t.pnl), 0);

    // Costs are surfaced here too, not only on the Report page. The Overview
    // tile is the number an operator glances at during the session, and a
    // gross figure sitting alone on the busiest screen is exactly the reading
    // error the charge model was added to remove — at ~Rs.105 a round trip a
    // "+Rs.60 day" is a losing one.
    const sumCharges = (rows) => rows.reduce((sum, t) => sum + (tradeCost(t).total ?? 0), 0);
    const todayCharges = sumCharges(closedToday);
    const totalCharges = sumCharges(priced);

    const squaredOff = closedTrades.filter((t) => t.closed_reason && t.closed_reason !== 'signal').length;

    res.json({
      status: 'ok',
      mode: req.mode,
      totalPnl: Number(totalPnl.toFixed(2)),
      todayPnl: Number(todayPnl.toFixed(2)),
      totalCharges: Number(totalCharges.toFixed(2)),
      todayCharges: Number(todayCharges.toFixed(2)),
      totalNetPnl: Number((totalPnl - totalCharges).toFixed(2)),
      todayNetPnl: Number((todayPnl - todayCharges).toFixed(2)),
      todayTrades: closedToday.length,
      totalClosedTrades: closedTrades.length,
      pricedTrades: priced.length,
      unpricedTrades: unpriced,
      forceClosedTrades: squaredOff,
      runningTrades: runningTrades.length,
      wins,
      losses,
      winRate: priced.length ? Number(((wins / priced.length) * 100).toFixed(2)) : 0,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Buckets closed trades by the IST calendar day/month they closed on.
 *
 * The date MUST be derived in IST, not from the server's local timezone. Render
 * runs in UTC, where a trade closed at 02:30 IST on 1 August carries a
 * closed_at of 31 July 21:00Z — `d.getMonth()` there files an August trade
 * under July, and the same slip moves the last ~5.5 hours of every trading day
 * into the previous day. Nothing about the output looks wrong when it happens.
 *
 * Unpriced trades (pnl null — premium could not be determined) are excluded
 * from both the P&L and the trade count, matching /pnl/summary. Counting them
 * with pnl coerced to 0 would show a bucket whose trade count disagrees with
 * the P&L it displays.
 */
function bucketClosedTrades(closedTrades, keyLength) {
  const buckets = new Map();

  for (const t of closedTrades) {
    if (!t.closed_at) continue;
    if (t.pnl === null || t.pnl === undefined) continue;

    const key = marketClock.istDate(new Date(t.closed_at).getTime()).slice(0, keyLength);
    const entry = buckets.get(key) || { key, pnl: 0, trades: 0, wins: 0, losses: 0 };
    const pnl = Number(t.pnl);
    entry.pnl += pnl;
    entry.trades += 1;
    if (pnl > 0) entry.wins += 1;
    else if (pnl < 0) entry.losses += 1;
    buckets.set(key, entry);
  }

  return Array.from(buckets.values())
    .map((b) => ({ ...b, pnl: Number(b.pnl.toFixed(2)) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Per-trading-day P&L plus the running cumulative total.
 *
 * This exists because monthly buckets are useless at this system's timescale —
 * a week of trading is a single bar, which is a stat tile pretending to be a
 * chart. Day granularity is what actually shows whether losses are steady or
 * concentrated, and `cumulative` is the equity curve.
 */
async function getDaily(req, res, next) {
  try {
    const closedTrades = await supabaseService.getClosedTradesSince(null, req.mode);
    const buckets = bucketClosedTrades(closedTrades, 10);

    let running = 0;
    const days = buckets.map((b) => {
      running += b.pnl;
      const { key, ...rest } = b;
      return { date: key, ...rest, cumulative: Number(running.toFixed(2)) };
    });

    res.json({ status: 'ok', mode: req.mode, days });
  } catch (err) {
    next(err);
  }
}

/* ==========================================================================
   Report
   ========================================================================== */

const COMPONENTS = ['brokerage', 'apiFee', 'stt', 'exchangeTxn', 'sebi', 'ipft', 'gst', 'stampDuty'];

/**
 * The cost of one trade, and where it came from.
 *
 * Trades closed before migration 004 have no stored charge. Rather than
 * showing a hole in the report, those are recomputed here from the premiums
 * and quantity already on the row — the arithmetic is deterministic, so the
 * only thing that can differ is the RATE, and rates move (STT on option sales
 * went 0.0625% -> 0.1% in Oct 2024).
 *
 * So a recomputed figure is tagged `estimated` and counted separately. A
 * report that quietly mixed "what was actually charged" with "what today's
 * rates would charge" would be indistinguishable from an accurate one, which
 * is the worst possible outcome for a page whose entire job is to be trusted
 * about money. Run scripts/backfill-charges.js to turn estimates into stored
 * values.
 */
function tradeCost(t) {
  if (t.charges !== null && t.charges !== undefined) {
    return { total: Number(t.charges), breakdown: t.charges_breakdown || null, estimated: false };
  }
  const computed = charges.computeRoundTrip({
    entryPremium: t.entry_price,
    exitPremium: t.exit_price,
    quantity: t.quantity,
  });
  if (!computed) return { total: null, breakdown: null, estimated: false };
  return { total: computed.total, breakdown: computed, estimated: true };
}

/**
 * Gross, cost and net for every closed trade — the page the whole charge
 * model exists to serve.
 *
 * Unpriced trades (no premium on one leg) are excluded from every money
 * figure and reported as their own count, exactly as /pnl/summary does. They
 * have no gross P&L, so giving them a cost would invent a loss that no
 * contract note would show.
 */
async function getReport(req, res, next) {
  try {
    const closedTrades = await supabaseService.getClosedTradesSince(null, req.mode);
    const priced = closedTrades.filter((t) => t.pnl !== null && t.pnl !== undefined);

    const totals = { grossPnl: 0, charges: 0, buyTurnover: 0, sellTurnover: 0 };
    const breakdown = Object.fromEntries(COMPONENTS.map((k) => [k, 0]));
    const days = new Map();
    let estimatedCount = 0;
    let uncostedCount = 0;
    let wins = 0;
    let losses = 0;

    for (const t of priced) {
      const gross = Number(t.pnl);
      const cost = tradeCost(t);
      const costTotal = cost.total ?? 0;
      if (cost.total == null) uncostedCount += 1;
      if (cost.estimated) estimatedCount += 1;

      totals.grossPnl += gross;
      totals.charges += costTotal;

      if (cost.breakdown) {
        for (const k of COMPONENTS) breakdown[k] += Number(cost.breakdown[k] || 0);
        totals.buyTurnover += Number(cost.breakdown.buyTurnover || 0);
        totals.sellTurnover += Number(cost.breakdown.sellTurnover || 0);
      }

      // Win/loss is judged on NET, not gross. That is the point of this page:
      // at ~Rs.105 a round trip, a +Rs.60 gross "win" is a loss, and counting
      // it as a win is how a losing system looks like a winning one.
      const net = gross - costTotal;
      if (net > 0) wins += 1;
      else if (net < 0) losses += 1;

      if (t.closed_at) {
        const key = marketClock.istDate(new Date(t.closed_at).getTime());
        const d = days.get(key) || { date: key, grossPnl: 0, charges: 0, netPnl: 0, trades: 0 };
        d.grossPnl += gross;
        d.charges += costTotal;
        d.netPnl += net;
        d.trades += 1;
        days.set(key, d);
      }
    }

    const r2 = (n) => Number(n.toFixed(2));
    let running = 0;
    const dayRows = Array.from(days.values())
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => {
        running += d.netPnl;
        return {
          date: d.date,
          trades: d.trades,
          grossPnl: r2(d.grossPnl),
          charges: r2(d.charges),
          netPnl: r2(d.netPnl),
          cumulativeNet: r2(running),
        };
      });

    res.json({
      status: 'ok',
      mode: req.mode,
      totals: {
        grossPnl: r2(totals.grossPnl),
        charges: r2(totals.charges),
        netPnl: r2(totals.grossPnl - totals.charges),
        tradeCount: priced.length,
        unpricedTrades: closedTrades.length - priced.length,
        wins,
        losses,
        winRate: priced.length ? r2((wins / priced.length) * 100) : 0,
        avgChargePerTrade: priced.length ? r2(totals.charges / priced.length) : 0,
        buyTurnover: r2(totals.buyTurnover),
        sellTurnover: r2(totals.sellTurnover),
        // How much of the charge column is a re-estimate rather than a
        // recorded fact. The UI shows this whenever it is non-zero.
        estimatedChargeTrades: estimatedCount,
        uncostedTrades: uncostedCount,
      },
      chargeBreakdown: Object.fromEntries(COMPONENTS.map((k) => [k, r2(breakdown[k])])),
      days: dayRows,
      rates: charges.rateCard(),
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getSummary, getDaily, getReport };

