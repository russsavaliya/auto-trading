'use strict';

const supabaseService = require('../services/supabaseService');
const marketData = require('../services/marketData');

async function listTrades(req, res, next) {
  try {
    const status = req.query.status || undefined;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const { trades, total } = await supabaseService.listTrades({ status, limit, offset });
    res.json({ status: 'ok', trades, total });
  } catch (err) {
    next(err);
  }
}

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
async function listRunningTrades(req, res, next) {
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
}

module.exports = { listTrades, listRunningTrades };
