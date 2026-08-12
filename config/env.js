'use strict';

require('dotenv').config();

/**
 * Single source of truth for configuration. Fails fast at startup if a
 * variable the server cannot safely run without is missing, instead of
 * limping along and failing confusingly on the first webhook.
 */
const REQUIRED_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'UPSTOX_API_BASE_URL',
  'UPSTOX_SANDBOX_ACCESS_TOKEN',
];

const missing = REQUIRED_VARS.filter((key) => !process.env[key] || process.env[key].trim() === '');
if (missing.length > 0) {
  // eslint-disable-next-line no-console
  console.error(`[config] Missing required environment variables: ${missing.join(', ')}`);
  console.error('[config] Copy .env.example to .env and fill these in before starting the server.');
  process.exit(1);
}

if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.trim() === '') {
  // eslint-disable-next-line no-console
  console.warn('[config] ADMIN_PASSWORD is not set — the /api admin dashboard routes will be disabled.');
}

if (!process.env.WEBHOOK_SECRET || process.env.WEBHOOK_SECRET.trim() === '') {
  // eslint-disable-next-line no-console
  console.warn('[config] WEBHOOK_SECRET is not set — the webhook endpoint will accept requests from anyone. Set this before exposing the server publicly.');
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
}

function parseIntEnv(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseIntEnv(process.env.PORT, 3000),
  logLevel: process.env.LOG_LEVEL || 'info',

  webhookSecret: process.env.WEBHOOK_SECRET || null,
  adminPassword: process.env.ADMIN_PASSWORD || null,
  adminAllowedOrigin: process.env.ADMIN_ALLOWED_ORIGIN || null,

  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY,
  
  upstoxApiBaseUrl: process.env.UPSTOX_API_BASE_URL.replace(/\/+$/, ''),  // https://api-sandbox.upstox.com/v2
  upstoxAccessToken: process.env.UPSTOX_SANDBOX_ACCESS_TOKEN,
  upstoxMaxRetries: parseIntEnv(process.env.UPSTOX_MAX_RETRIES, 2),
  upstoxRetryBaseDelayMs: parseIntEnv(process.env.UPSTOX_RETRY_BASE_DELAY_MS, 500),

  defaultInstrumentToken: process.env.DEFAULT_INSTRUMENT_TOKEN || null,
  defaultQuantity: process.env.DEFAULT_QUANTITY ? parseIntEnv(process.env.DEFAULT_QUANTITY, null) : null,
  defaultProduct: process.env.DEFAULT_PRODUCT || 'I',
  defaultOrderType: process.env.DEFAULT_ORDER_TYPE || 'MARKET',

  // ATM instrument auto-resolution — used when a webhook doesn't include an
  // explicit instrument_token, so entries don't depend on a manually
  // maintained value. See services/instrumentResolver.js.
  strikeInterval: parseIntEnv(process.env.STRIKE_INTERVAL, 100),
  instrumentMasterCacheTtlMs: parseIntEnv(process.env.INSTRUMENT_MASTER_CACHE_TTL_MS, 6 * 60 * 60 * 1000),

  // Fallback only — used if the Supabase app_config read fails. Real toggling
  // should happen via the app_config.trading_enabled row (see kill switch docs).
  tradingEnabledFallback: parseBool(process.env.TRADING_ENABLED, true),

  duplicateWindowSeconds: parseIntEnv(process.env.DUPLICATE_WINDOW_SECONDS, 30),

  // --------------------------------------------------------------------------
  // Intraday session rules (all IST — see utils/marketClock.js).
  //
  // These are enforced SERVER-SIDE on purpose. The Pine script also refuses to
  // emit late entries, but Pine can only act when a bar closes: if no exit
  // condition is ever met, a position would otherwise sit open indefinitely.
  // Two positions were carried overnight during the 6-12 Aug paper run, one of
  // them across a weekend, purely because nothing here forced them shut.
  // --------------------------------------------------------------------------
  marketOpenIst: process.env.MARKET_OPEN_IST || '09:15',
  marketCloseIst: process.env.MARKET_CLOSE_IST || '15:30',
  // No new position may be opened at/after this time.
  entryCutoffIst: process.env.ENTRY_CUTOFF_IST || '14:45',
  // Anything still open at/after this time is force-closed by the scheduler.
  // Deliberately 5 minutes AFTER the Pine script's own 15:15 square-off: in
  // normal operation Pine closes the position first and this never fires, so
  // there is no duplicate exit to reject. This is the safety net for when
  // TradingView does not deliver (delayed feed, alert expired, chart closed).
  squareOffIst: process.env.SQUARE_OFF_IST || '15:20',
  squareOffEnabled: parseBool(process.env.SQUARE_OFF_ENABLED, true),
  squareOffPollSeconds: parseIntEnv(process.env.SQUARE_OFF_POLL_SECONDS, 60),

  // --------------------------------------------------------------------------
  // Paper-fill pricing.
  //
  // The Upstox sandbox never fills anything (every order stays "open pending"
  // with average_price 0), so P&L has to be marked against the option's real
  // traded price. This is the allowance for the bid-ask you would actually have
  // crossed with a MARKET order — applied against you on BOTH legs.
  // On BANKNIFTY monthly ATM, 1.5 points at 30 qty is ~₹90 per round trip.
  // Set to 0 only if you want to see gross, pre-cost results.
  // --------------------------------------------------------------------------
  paperSlippagePoints: Number.isFinite(parseFloat(process.env.PAPER_SLIPPAGE_POINTS))
    ? parseFloat(process.env.PAPER_SLIPPAGE_POINTS)
    : 1.5,
};

module.exports = config;
