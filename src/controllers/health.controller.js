'use strict';

const config = require('../config/env');
const logger = require('../utils/logger');
const supabaseService = require('../services/supabaseService');
const marketClock = require('../utils/marketClock');

async function health(req, res) {
  let reachable = false;
  let tradingEnabled = null;
  let entriesEnabled = null;
  try {
    ({ reachable, tradingEnabled, entriesEnabled } = await supabaseService.getAppConfigStatus());
  } catch (err) {
    logger.error({ err: err.message }, 'Health check: failed to reach Supabase');
  }

  res.status(reachable ? 200 : 503).json({
    status: reachable ? 'ok' : 'degraded',
    trading_enabled: tradingEnabled,
    entries_enabled: entriesEnabled,
    db_reachable: reachable,
    sandbox_mode: true,
    market_open: marketClock.isMarketOpen(Date.now(), config),
    ist_time: marketClock.istString(),
    entry_cutoff_ist: config.entryCutoffIst,
    square_off_ist: config.squareOffIst,
    time: new Date().toISOString(),
  });
}

module.exports = { health };
