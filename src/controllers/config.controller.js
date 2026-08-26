'use strict';

const supabaseService = require('../services/supabaseService');

/**
 * Backs the header toggle on the dashboard. Reads app_config fresh (same path
 * as the trading kill switch itself), so the toggle always reflects reality
 * even if trading_enabled was flipped directly in Supabase.
 */
async function getConfig(req, res, next) {
  try {
    const { reachable, tradingEnabled } = await supabaseService.getAppConfigStatus();
    if (!reachable) {
      res.status(503).json({ status: 'error', message: 'Could not read app_config' });
      return;
    }
    res.json({ status: 'ok', trading_enabled: tradingEnabled });
  } catch (err) {
    next(err);
  }
}

async function updateConfig(req, res, next) {
  try {
    const { trading_enabled: tradingEnabled } = req.body || {};
    if (typeof tradingEnabled !== 'boolean') {
      res.status(400).json({ status: 'error', message: 'trading_enabled must be a boolean' });
      return;
    }
    const updated = await supabaseService.setTradingEnabled(tradingEnabled);
    res.json({ status: 'ok', trading_enabled: updated.trading_enabled });
  } catch (err) {
    next(err);
  }
}

module.exports = { getConfig, updateConfig };
