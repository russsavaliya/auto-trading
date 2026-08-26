'use strict';

/**
 * Process entry point. Everything about *what* the server does lives in
 * src/ — this file only owns the process lifecycle: the pre-flight timezone
 * check, binding the port, arming the schedulers once the schema is known
 * good, and shutting down cleanly.
 */
const app = require('./src/app');
const config = require('./src/config/env');
const logger = require('./src/utils/logger');
const supabaseService = require('./src/services/supabaseService');
const instrumentResolver = require('./src/services/instrumentResolver');
const scheduler = require('./src/services/scheduler');
const positionMonitor = require('./src/services/positionMonitor');
const marketClock = require('./src/utils/marketClock');

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
      // Only arm the exit machinery once the schema can actually record a close.
      if (r.ok) {
        scheduler.start();
        positionMonitor.start();
      } else {
        logger.error('Schedulers NOT started — fix the schema first, then restart.');
      }
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
