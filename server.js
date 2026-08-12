'use strict';

const express = require('express');
const config = require('./config/env');
const logger = require('./utils/logger');
const webhookRouter = require('./routes/webhook');
const adminRouter = require('./routes/admin');
const supabaseService = require('./services/supabaseService');
const instrumentResolver = require('./services/instrumentResolver');
const scheduler = require('./services/scheduler');
const marketClock = require('./utils/marketClock');

const app = express();

app.use(express.json({ limit: '1mb' }));

// CORS for the admin dashboard frontend only — the webhook endpoint doesn't
// need it (TradingView calls it server-to-server, not from a browser).
app.use('/api', (req, res, next) => {
  const origin = config.adminAllowedOrigin || '*';
  res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-password');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get('/health', async (req, res) => {
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
});

app.use('/webhook', webhookRouter);
app.use('/api', adminRouter);

app.use((req, res) => {
  res.status(404).json({ status: 'error', message: 'Not found' });
});

// Final safety net: catches anything thrown synchronously or passed to
// next(err) that slipped past the route-level try/catch, so a bug never
// takes the whole process down mid-trading-session.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error({ err: err.message, stack: err.stack }, 'Unhandled error reached top-level error handler');
  res.status(500).json({ status: 'error', message: 'Internal server error' });
});

// Checked before the server accepts anything: if the runtime cannot resolve
// Asia/Kolkata, every session rule silently applies 5h30m off and no error
// would ever surface. Better to refuse to start.
const tz = marketClock.assertTimezoneSupport();
if (!tz.ok) {
  logger.error({ rendered: tz.rendered, expected: tz.expected }, `TIMEZONE SUPPORT MISSING — ${tz.detail}`);
  process.exit(1);
}

const server = app.listen(config.port, () => {
  logger.info(`TradingView -> Upstox webhook bridge listening on port ${config.port} (${config.nodeEnv})`);
  logger.info(`Sandbox base URL: ${config.upstoxApiBaseUrl}`);
  logger.info(`Webhook endpoint: POST /webhook/tradingview`);
  logger.info(`IST now ${marketClock.istString()} — entry cutoff ${config.entryCutoffIst}, square-off ${config.squareOffIst}`);
  instrumentResolver.warmUp();
  supabaseService
    .verifySchema()
    .then((r) => {
      // Only arm the square-off once the schema can actually record a close.
      if (r.ok) scheduler.start();
      else logger.error('Square-off scheduler NOT started — fix the schema first, then restart.');
    })
    .catch((err) => logger.error({ err: err.message }, 'Schema check failed to run'));
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down');
  server.close(() => process.exit(0));
});

module.exports = app;
