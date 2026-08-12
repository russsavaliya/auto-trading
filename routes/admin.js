'use strict';

const express = require('express');
const config = require('../config/env');
const supabaseService = require('../services/supabaseService');
const marketData = require('../services/marketData');
const marketClock = require('../utils/marketClock');
const { requireAdminPassword } = require('../middleware/adminAuth');

const router = express.Router();

// Login: the frontend only holds a password (from its own env), it never
// stores a session server-side — this just confirms the password is right
// before the frontend starts sending it as a header on every request.
router.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (!config.adminPassword) {
    res.status(503).json({ status: 'error', message: 'Admin panel is not configured' });
    return;
  }
  if (password && password === config.adminPassword) {
    res.json({ status: 'ok' });
    return;
  }
  res.status(401).json({ status: 'error', message: 'Invalid password' });
});

router.use(requireAdminPassword);

router.get('/webhook-logs', async (req, res, next) => {
  try {
    const { processed: processedRaw, limit: limitRaw, offset: offsetRaw } = req.query;
    const processed = processedRaw === undefined ? undefined : processedRaw === 'true';
    const limit = Math.min(parseInt(limitRaw, 10) || 50, 200);
    const offset = parseInt(offsetRaw, 10) || 0;
    const { logs, total } = await supabaseService.listWebhookLogs({ processed, limit, offset });
    res.json({ status: 'ok', logs, total });
  } catch (err) {
    next(err);
  }
});

router.get('/trades', async (req, res, next) => {
  try {
    const status = req.query.status || undefined;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const { trades, total } = await supabaseService.listTrades({ status, limit, offset });
    res.json({ status: 'ok', trades, total });
  } catch (err) {
    next(err);
  }
});

/**
 * Open positions, each marked to the option's current traded price.
 *
 * Without the mark the dashboard could only show what you paid, which tells
 * you nothing about whether the position is currently winning or losing — the
 * one thing you actually want from a "running trades" view. The mark uses the
 * same source as the paper-fill pricing, so an open trade and the closed trade
 * it becomes are valued consistently.
 *
 * A failed mark yields nulls rather than an error: a stale price must never
 * take down the dashboard, and the frontend renders "—" for it.
 */
router.get('/trades/running', async (req, res, next) => {
  try {
    const trades = await supabaseService.listRunningTrades();

    const marked = await Promise.all(
      trades.map(async (t) => {
        let mark = null;
        try {
          mark = t.instrument_token ? await marketData.getPremiumAt(t.instrument_token) : null;
        } catch {
          mark = null;
        }

        const entry = t.entry_price == null ? null : Number(t.entry_price);
        const current = mark ? mark.premium : null;
        const unrealizedPnl =
          entry != null && current != null ? Number(((current - entry) * Number(t.quantity)).toFixed(2)) : null;

        return {
          ...t,
          current_premium: current,
          current_premium_at: mark ? mark.candleAt : null,
          unrealized_pnl: unrealizedPnl,
        };
      })
    );

    res.json({ status: 'ok', trades: marked });
  } catch (err) {
    next(err);
  }
});

router.get('/positions', async (req, res, next) => {
  try {
    const positions = await supabaseService.listPositionStates();
    res.json({ status: 'ok', positions });
  } catch (err) {
    next(err);
  }
});

router.get('/pnl/summary', async (req, res, next) => {
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
});

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

router.get('/pnl/monthly', async (req, res, next) => {
  try {
    const closedTrades = await supabaseService.getClosedTradesSince(null);
    const months = bucketClosedTrades(closedTrades, 7).map(({ key, ...rest }) => ({ month: key, ...rest }));
    res.json({ status: 'ok', months });
  } catch (err) {
    next(err);
  }
});

/**
 * Per-trading-day P&L plus the running cumulative total.
 *
 * This exists because monthly buckets are useless at this system's timescale —
 * a week of trading is a single bar, which is a stat tile pretending to be a
 * chart. Day granularity is what actually shows whether losses are steady or
 * concentrated, and `cumulative` is the equity curve.
 */
router.get('/pnl/daily', async (req, res, next) => {
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
});

module.exports = router;
