'use strict';

const supabaseService = require('../services/supabaseService');
const marketClock = require('../utils/marketClock');

async function getSummary(req, res, next) {
  try {
    const closedTrades = await supabaseService.getClosedTradesSince(null);
    const runningTrades = await supabaseService.listRunningTrades();

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
    const todayPnl = priced
      .filter((t) => t.closed_at && new Date(t.closed_at) >= todayStart)
      .reduce((sum, t) => sum + Number(t.pnl), 0);

    const squaredOff = closedTrades.filter((t) => t.closed_reason && t.closed_reason !== 'signal').length;

    res.json({
      status: 'ok',
      totalPnl: Number(totalPnl.toFixed(2)),
      todayPnl: Number(todayPnl.toFixed(2)),
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

async function getMonthly(req, res, next) {
  try {
    const closedTrades = await supabaseService.getClosedTradesSince(null);
    const months = bucketClosedTrades(closedTrades, 7).map(({ key, ...rest }) => ({ month: key, ...rest }));
    res.json({ status: 'ok', months });
  } catch (err) {
    next(err);
  }
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
    const closedTrades = await supabaseService.getClosedTradesSince(null);
    const buckets = bucketClosedTrades(closedTrades, 10);

    let running = 0;
    const days = buckets.map((b) => {
      running += b.pnl;
      const { key, ...rest } = b;
      return { date: key, ...rest, cumulative: Number(running.toFixed(2)) };
    });

    res.json({ status: 'ok', days });
  } catch (err) {
    next(err);
  }
}

module.exports = { getSummary, getMonthly, getDaily };
