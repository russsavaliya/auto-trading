'use strict';

const axios = require('axios');
const config = require('../config/env');
const logger = require('../utils/logger');
const supabaseService = require('./supabaseService');
const { LIVE, PAPER } = require('../config/modes');

/**
 * Live access tokens: minting them, storing them, and knowing when they die.
 *
 * WHY THIS IS NOT AN ENV VAR
 * The live token expires at 3:30 AM IST every day, whenever it was issued —
 * a token minted at 8 PM tonight is dead at 3:30 tomorrow morning. Holding it
 * in the environment would mean a Render redeploy every single trading day,
 * before the market opens, forever.
 *
 * It also has to be readable by a RUNNING server. On 2 Sep 2026 the sandbox
 * token expired at 03:30, the first signal arrived at 09:25, and every order
 * for the next six hours returned 401 with nothing on screen to say why —
 * because the token had been baked into an axios client at module load. That
 * failure is the reason this module exists and why nothing here caches.
 *
 * WHAT IS NOT AUTOMATED, AND WHY
 * Upstox's daily flow requires a human to log in (credentials + TOTP) — there
 * is no refresh_token in the standard grant. So this cannot be made fully
 * unattended without storing broker credentials, which this project will not
 * do. The design is instead: one click a day on the Settings page, and a
 * dashboard that shouts well before the token runs out.
 */

const AUTH_HOST = 'https://api.upstox.com';
const DIALOG_URL = `${AUTH_HOST}/v2/login/authorization/dialog`;
const TOKEN_URL = `${AUTH_HOST}/v2/login/authorization/token`;

/** Everything the live flow needs before it can do anything at all. */
function liveCredentialsMissing() {
  const missing = [];
  if (!config.upstoxApiKey) missing.push('UPSTOX_API_KEY');
  if (!config.upstoxApiSecret) missing.push('UPSTOX_API_SECRET');
  if (!config.upstoxRedirectUri) missing.push('UPSTOX_REDIRECT_URI');
  return missing;
}

/**
 * Where to send the operator to log in. `state` is round-tripped by Upstox and
 * checked on the way back, so a stray callback cannot mint a token.
 */
function buildLoginUrl(state) {
  const missing = liveCredentialsMissing();
  if (missing.length) {
    throw new Error(`Live credentials not configured: ${missing.join(', ')}`);
  }
  const params = new URLSearchParams({
    client_id: config.upstoxApiKey,
    redirect_uri: config.upstoxRedirectUri,
    response_type: 'code',
    state,
  });
  return `${DIALOG_URL}?${params.toString()}`;
}

/**
 * When this token actually dies.
 *
 * Read from the token itself rather than computed. Upstox's token is a JWT
 * carrying an `exp` claim, and that is the authority — "3:30 AM tomorrow" is
 * the documented rule, but a rule and the thing being enforced can drift, and
 * this number is what the dashboard counts down to. Falls back to the next
 * 03:30 IST only when the token is not a decodable JWT.
 */
function expiryOf(accessToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(accessToken).split('.')[1], 'base64url').toString());
    if (payload && Number.isFinite(payload.exp)) return new Date(payload.exp * 1000);
  } catch {
    // Not a JWT, or shaped differently than expected — fall through.
  }
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  ist.setUTCHours(3, 30, 0, 0);
  let next = new Date(ist.getTime() - 5.5 * 3600 * 1000);
  if (next <= now) next = new Date(next.getTime() + 24 * 3600 * 1000);
  return next;
}

/**
 * Trades the one-time `code` from the callback for an access token and stores
 * it. The code is single-use whether or not it succeeds, so a failure here
 * means starting the login again rather than retrying.
 */
async function exchangeCode(code) {
  const missing = liveCredentialsMissing();
  if (missing.length) throw new Error(`Live credentials not configured: ${missing.join(', ')}`);

  const body = new URLSearchParams({
    code,
    client_id: config.upstoxApiKey,
    client_secret: config.upstoxApiSecret,
    redirect_uri: config.upstoxRedirectUri,
    grant_type: 'authorization_code',
  });

  try {
    const res = await axios.post(TOKEN_URL, body.toString(), {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
    });

    const accessToken = res.data?.access_token;
    if (!accessToken) throw new Error(`No access_token in response: ${JSON.stringify(res.data)}`);

    const expiresAt = expiryOf(accessToken);
    await supabaseService.saveBrokerToken(LIVE, {
      accessToken,
      refreshToken: res.data?.extended_token || null,
      expiresAt: expiresAt.toISOString(),
      userId: res.data?.user_id || null,
    });

    logger.info(
      { userId: res.data?.user_id, expiresAt: expiresAt.toISOString() },
      'Live access token stored'
    );
    return { userId: res.data?.user_id || null, expiresAt };
  } catch (err) {
    // Upstox puts the useful part in the body, not the status text.
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    await supabaseService.recordBrokerTokenError(LIVE, detail);
    logger.error({ err: detail }, 'Live token exchange failed');
    throw new Error(`Token exchange failed: ${detail}`);
  }
}

/**
 * The token to authenticate a live request with, or null when there isn't a
 * usable one.
 *
 * Never returns an expired token. Returning one would turn a knowable,
 * reportable condition into a 401 at the worst possible moment — which is
 * exactly what happened on 2 Sep. A null here is what lets the caller refuse
 * the order and say why.
 */
async function getAccessToken(mode = PAPER) {
  if (mode !== LIVE) return config.upstoxAccessToken;

  const row = await supabaseService.getBrokerToken(LIVE);
  if (!row || !row.access_token) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;
  return row.access_token;
}

/**
 * What the dashboard is allowed to know. Deliberately never includes the token
 * itself — the admin password is not strong enough protection for a
 * credential that can place real orders.
 */
async function tokenStatus(mode = LIVE) {
  const missing = liveCredentialsMissing();
  if (mode === LIVE && missing.length) {
    return { state: 'not_configured', missing, expiresAt: null, hoursLeft: null, userId: null };
  }

  const row = await supabaseService.getBrokerToken(mode);
  if (!row || !row.access_token) {
    return { state: 'no_token', missing: [], expiresAt: null, hoursLeft: null, userId: null, lastError: row?.last_error || null };
  }

  const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
  const msLeft = expiresAt ? expiresAt.getTime() - Date.now() : null;

  return {
    state: msLeft != null && msLeft <= 0 ? 'expired' : 'valid',
    missing: [],
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    hoursLeft: msLeft == null ? null : Number((msLeft / 3600000).toFixed(1)),
    userId: row.user_id || null,
    lastError: row.last_error || null,
  };
}

module.exports = {
  buildLoginUrl,
  exchangeCode,
  getAccessToken,
  tokenStatus,
  liveCredentialsMissing,
  expiryOf,
};
