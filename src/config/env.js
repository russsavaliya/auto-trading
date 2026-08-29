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

/** Fractions (0.05 = 5%) and other decimals. Rejects NaN rather than
 * propagating it into a stop-loss comparison, where NaN silently disables the
 * rule because every comparison against it is false. */
function parseFloatEnv(value, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
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

  // --------------------------------------------------------------------------
  // Premium-based exit management (services/positionMonitor.js).
  //
  // The Pine score cannot book a profit. It is built from EMA/Supertrend/MACD
  // on the INDEX, so it only fires an exit once the trend measure has decayed —
  // by which time the option premium has already peaked and round-tripped.
  // Over 13-14 Aug 2026, 10 of 12 trades were in profit at some point and
  // Rs.11,064 was handed back waiting for a score-based exit.
  //
  // These rules watch the PREMIUM — the thing actually owned — and act on it.
  // Backtested conservatively (1-minute closes only, the resolution a poller
  // can really act on) across all 37 trades from 6-14 Aug: the score-based
  // exits produced -Rs.13,061; these defaults produce -Rs.7,612. Every
  // combination tested beat the score-based exit, so the improvement is not an
  // artefact of picking the best row.
  //
  // NOTE: this bounds the damage; it does NOT make the strategy profitable.
  // The entry signal has negative edge (the index moved in the signalled
  // direction on 2 of 12 trades at the 15-minute mark), and no exit rule can
  // fix a bad entry.
  // --------------------------------------------------------------------------
  exitRulesEnabled: parseBool(process.env.EXIT_RULES_ENABLED, true),
  // Hard stop: close if the premium falls this fraction below the entry.
  stopLossPct: parseFloatEnv(process.env.STOP_LOSS_PCT, 0.1),
  // The trailing stop stays disarmed until the position is this far in profit,
  // so normal noise around the entry price cannot trigger it.
  trailArmPct: parseFloatEnv(process.env.TRAIL_ARM_PCT, 0.03),
  // Once armed, close if the premium retraces this far from its peak.
  trailPct: parseFloatEnv(process.env.TRAIL_PCT, 0.05),
  // Never let the trailing stop fire BELOW what we paid plus the friction of
  // getting out.
  //
  // Without this the trail arms at +3% but a 5% retrace from the peak only
  // stays above entry once the peak is +5.26%, so every peak between those two
  // arms a stop whose trigger price is already under water — an exit that can
  // only book a loss. Measured over 17-28 Aug, 7 trades armed into that hole.
  //
  // The floor is a clamp on the trigger, NOT a refusal to arm: refusing would
  // leave the position running to the 30-minute time stop or the -10% hard
  // stop, which makes the tail worse than the small loss the trail was taking.
  // Clamping keeps the protective exit and only forbids it from firing at a
  // loss — the standard "move the stop to breakeven" rule.
  //
  // Verified against every trade with a recorded peak: the clamp does not bind
  // on ANY trade entered before 10:00, so the opening trades — the only ones
  // currently making money — behave identically with it on or off.
  trailBreakevenFloor: parseBool(process.env.TRAIL_BREAKEVEN_FLOOR, true),
  // Give up on a position that has gone nowhere. 0 disables the time stop.
  maxHoldMinutes: parseIntEnv(process.env.MAX_HOLD_MINUTES, 30),
  exitPollSeconds: parseIntEnv(process.env.EXIT_POLL_SECONDS, 30),

  // After a stop-loss / trailing / time exit, refuse a SAME-DIRECTION re-entry
  // for this long. The Pine script re-sends its entry every few bars while the
  // bias holds (so it stays in step after a server exit it cannot see), which
  // without this would walk straight back into the trade the stop just closed —
  // repeatedly. A reversal to the other side is still allowed immediately.
  reEntryCooldownMinutes: parseIntEnv(process.env.RE_ENTRY_COOLDOWN_MINUTES, 15),

  // --------------------------------------------------------------------------
  // Daily trade cap. 0 disables it.
  //
  // This is the single most robust rule in the whole dataset, and it does not
  // depend on any pattern being real. Both independent measurements say the
  // per-trade expectancy is NEGATIVE (-Rs.155/trade live over 57 trades;
  // -17.84/trade in TradingView's own Feb-Aug backtest, profit factor 0.516).
  // When expectancy is negative, fewer trades is better arithmetically — no
  // amount of data-mining can make that conclusion wrong.
  //
  // The measured effect is monotonic in BOTH windows, which is much harder to
  // get by chance than a single lucky cell:
  //
  //                      6-21 Aug (57 trades)   17-21 Aug (20 trades)
  //   no cap                   -Rs.8,859              +Rs.4,202
  //   max 3/day                -Rs.4,545              +Rs.4,368
  //   max 2/day                +Rs.  795              +Rs.5,459
  //   max 1/day                +Rs.5,444              +Rs.7,770
  //
  // 2 is chosen over 1 deliberately: 1/day is the extreme end of the sweep and
  // the most likely to be over-fit, and it would yield only ~20 trades a month
  // to learn from. 2 keeps a safety margin and collects twice the evidence.
  //
  // Stopping the day after a win is handled MANUALLY via the dashboard kill
  // switch, not here — it tests the same (+Rs.3,116 / +Rs.6,777) and leaving it
  // manual keeps a human in the loop on the day's outcome.
  // --------------------------------------------------------------------------
  maxTradesPerDay: parseIntEnv(process.env.MAX_TRADES_PER_DAY, 2),
};

/**
 * What a round trip costs in premium points — slippage crossed on the way in
 * AND on the way out. Derived rather than configured separately so it can
 * never drift out of step with the fill pricing that actually charges it.
 */
config.roundTripCostPoints = config.paperSlippagePoints * 2;

module.exports = config;
