'use strict';

const express = require('express');
const config = require('../config/env');
const supabaseService = require('../services/supabaseService');
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

router.get('/trades/running', async (req, res, next) => {
  try {
    const trades = await supabaseService.listRunningTrades();
    res.json({ status: 'ok', trades });
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

    const totalPnl = closedTrades.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
    const wins = closedTrades.filter((t) => Number(t.pnl) > 0).length;
    const losses = closedTrades.filter((t) => Number(t.pnl) < 0).length;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayPnl = closedTrades
      .filter((t) => t.closed_at && new Date(t.closed_at) >= todayStart)
      .reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);

    res.json({
      status: 'ok',
      totalPnl: Number(totalPnl.toFixed(2)),
      todayPnl: Number(todayPnl.toFixed(2)),
      totalClosedTrades: closedTrades.length,
      runningTrades: runningTrades.length,
      wins,
      losses,
      winRate: closedTrades.length ? Number(((wins / closedTrades.length) * 100).toFixed(2)) : 0,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/pnl/monthly', async (req, res, next) => {
  try {
    const closedTrades = await supabaseService.getClosedTradesSince(null);
    const byMonth = new Map();

    for (const t of closedTrades) {
      const d = new Date(t.closed_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const entry = byMonth.get(key) || { month: key, pnl: 0, trades: 0 };
      entry.pnl += Number(t.pnl) || 0;
      entry.trades += 1;
      byMonth.set(key, entry);
    }

    const months = Array.from(byMonth.values())
      .map((m) => ({ ...m, pnl: Number(m.pnl.toFixed(2)) }))
      .sort((a, b) => a.month.localeCompare(b.month));
    res.json({ status: 'ok', months });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
