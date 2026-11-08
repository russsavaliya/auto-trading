'use strict';

const config = require('../config/env');
const logger = require('../utils/logger');
const supabaseService = require('../services/supabaseService');
const marketClock = require('../utils/marketClock');
const upstoxAuth = require('../services/upstoxAuth');
const modes = require('../config/modes');

async function health(req, res) {
  let reachable = false;
  let tradingEnabled = null;
  let entriesEnabled = null;
  try {
    ({ reachable, tradingEnabled, entriesEnabled } = await supabaseService.getAppConfigStatus());
  } catch (err) {
    logger.error({ err: err.message }, 'Health check: failed to reach Supabase');
  }

  // Live token health belongs in /health so an uptime monitor can see the
  // token dying BEFORE the market opens. On 2 Sep 2026 it expired at 03:30
  // and nothing noticed until the first order failed at 09:25.
  let liveToken = null;
  if (config.liveEnabled) {
    try {
      liveToken = await upstoxAuth.tokenStatus(modes.LIVE);
    } catch (err) {
      logger.error({ err: err.message }, 'Health check: could not read live token status');
    }
  }

  const liveHealthy = !config.liveEnabled || (liveToken && liveToken.state === 'valid');

  res.status(reachable ? 200 : 503).json({
    status: reachable ? (liveHealthy ? 'ok' : 'degraded') : 'degraded',
    trading_enabled: tradingEnabled,
    entries_enabled: entriesEnabled,
    db_reachable: reachable,
    paper: { enabled: true, sandbox: true },
    live: {
      enabled: config.liveEnabled,
      token_state: liveToken ? liveToken.state : 'disabled',
      token_expires_at: liveToken ? liveToken.expiresAt : null,
      token_hours_left: liveToken ? liveToken.hoursLeft : null,
    },
    sandbox_mode: true,
    market_open: marketClock.isMarketOpen(Date.now(), config),
    ist_time: marketClock.istString(),
    entry_cutoff_ist: config.entryCutoffIst,
    square_off_ist: config.squareOffIst,
    time: new Date().toISOString(),
  });
}

module.exports = { health };
