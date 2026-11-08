'use strict';

const supabaseService = require('../services/supabaseService');
const charges = require('../services/charges');
const upstoxAuth = require('../services/upstoxAuth');
const modes = require('../config/modes');
const envConfig = require('../config/env');

/**
 * Backs the Settings page.
 *
 * Everything here reads app_config fresh on every request — no caching. The
 * kill switch and the daily cap can both be changed directly in Supabase, and
 * a Settings page that showed a stale value would be worse than no Settings
 * page at all: it would invite someone to "turn trading off" on a screen that
 * was already lying about the current state.
 */
async function getConfig(req, res, next) {
  try {
    const mode = req.mode || modes.PAPER;
    const { reachable, tradingEnabled } = await supabaseService.getAppConfigStatus(mode);
    if (!reachable) {
      res.status(503).json({ status: 'error', message: `Could not read app_config for mode "${mode}"` });
      return;
    }
    const runtime = await supabaseService.getRuntimeConfig(mode);

    // Live-only. Reported even when the caller asked about paper, because the
    // Settings page shows one connection panel regardless of which environment
    // is being viewed — and a token quietly expiring is the failure this whole
    // build exists to make visible.
    const liveToken = await upstoxAuth.tokenStatus(modes.LIVE);

    res.json({
      status: 'ok',
      mode,
      live: {
        // Master switch from the environment; separate from the per-mode kill
        // switch, and both have to be on before a real order can go out.
        enabled: envConfig.liveEnabled,
        token: liveToken,
        algo_name: envConfig.upstoxAlgoName,
        order_host: modes.resolve(modes.LIVE).orderBaseUrl,
      },
      trading_enabled: tradingEnabled,
      max_trades_per_day: runtime.maxTradesPerDay,
      re_entry_cooldown_enabled: runtime.reEntryCooldownEnabled,
      re_entry_cooldown_minutes: runtime.reEntryCooldownMinutes,
      // 'env-fallback' means migration 004 has not been applied, so edits
      // below will not stick. The UI says so rather than silently accepting
      // a change that the next request will not reflect.
      config_source: runtime.source,
      rates: charges.rateCard(),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Bounds for every numeric setting.
 *
 * These are guard rails, not preferences. `maxTradesPerDay` at 0 disables the
 * cap — that is a legitimate, deliberate choice — but there is no sane reason
 * for it to be 500, and a typo that turned the one measured-positive rule in
 * this system into "unlimited" should be rejected at the door rather than
 * discovered in the next day's P&L.
 */
const LIMITS = {
  max_trades_per_day: { min: 0, max: 50, key: 'maxTradesPerDay' },
  re_entry_cooldown_minutes: { min: 0, max: 240, key: 'reEntryCooldownMinutes' },
};

async function updateConfig(req, res, next) {
  try {
    const body = req.body || {};
    const patch = {};
    const errors = [];

    const mode = req.mode || modes.PAPER;

    if (body.trading_enabled !== undefined) {
      if (typeof body.trading_enabled !== 'boolean') {
        errors.push('trading_enabled must be a boolean');
      } else if (body.trading_enabled && mode === modes.LIVE) {
        // Turning LIVE on is the one setting that starts spending real money,
        // so it is refused unless the plumbing behind it actually works. A
        // switch that flips green while every order 401s is worse than one
        // that refuses and says why.
        const missing = upstoxAuth.liveCredentialsMissing();
        if (!envConfig.liveEnabled) {
          errors.push('LIVE_TRADING_ENABLED is off in the environment — live cannot be switched on from here');
        } else if (missing.length) {
          errors.push(`live is not configured: missing ${missing.join(', ')}`);
        } else if (!(await upstoxAuth.getAccessToken(modes.LIVE))) {
          errors.push('no valid live access token — connect Upstox first');
        } else {
          await supabaseService.setTradingEnabled(true, mode);
        }
      } else {
        await supabaseService.setTradingEnabled(body.trading_enabled, mode);
      }
    }

    if (body.re_entry_cooldown_enabled !== undefined) {
      if (typeof body.re_entry_cooldown_enabled !== 'boolean') {
        errors.push('re_entry_cooldown_enabled must be a boolean');
      } else {
        patch.reEntryCooldownEnabled = body.re_entry_cooldown_enabled;
      }
    }

    for (const [field, { min, max, key }] of Object.entries(LIMITS)) {
      if (body[field] === undefined) continue;
      const n = Number(body[field]);
      if (!Number.isInteger(n) || n < min || n > max) {
        errors.push(`${field} must be a whole number between ${min} and ${max}`);
        continue;
      }
      patch[key] = n;
    }

    if (errors.length) {
      res.status(400).json({ status: 'error', message: errors.join('; ') });
      return;
    }

    if (Object.keys(patch).length) {
      // Refuse loudly rather than 500-ing. Without migration 004 these values
      // are being served from env vars, so a write has nowhere to land — and
      // "Internal server error" would send someone reading server logs when
      // the fix is one SQL file. The Settings page disables these fields in
      // this state; this is the guard for anything that bypasses the UI.
      const current = await supabaseService.getRuntimeConfig(mode);
      if (current.source === 'env-fallback') {
        res.status(409).json({
          status: 'error',
          message:
            'Settings are not writable yet — app_config is missing the columns from ' +
            'sql/migrations/004_charges_and_runtime_config.sql. Apply it against Supabase, then retry.',
        });
        return;
      }
      await supabaseService.setRuntimeConfig(patch, mode);
    }

    // Respond with the state as it now actually is, read back from the
    // database — not with an echo of the request. If a write silently did not
    // land, the Settings page must show that, not the value it hoped for.
    await getConfig(req, res, next);
  } catch (err) {
    next(err);
  }
}

module.exports = { getConfig, updateConfig };
