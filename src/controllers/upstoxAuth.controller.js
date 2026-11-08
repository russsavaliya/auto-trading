'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');
const upstoxAuth = require('../services/upstoxAuth');
const config = require('../config/env');
const { LIVE } = require('../config/modes');

/**
 * The once-a-day "connect Upstox" flow.
 *
 * Upstox's standard grant issues no refresh token and requires a human login
 * with TOTP, so this cannot be made unattended without storing broker
 * credentials — which this project will not do. What it CAN do is make the
 * daily reconnect a single click and make the countdown to expiry impossible
 * to miss.
 *
 * THE CALLBACK IS NOT BEHIND THE ADMIN PASSWORD.
 * Upstox redirects the operator's browser to it, and that browser will not be
 * sending an x-admin-password header. The `state` value below is what secures
 * it instead: a random single-use token minted when the login starts and
 * required to match on the way back, so a stray or replayed callback cannot
 * mint anything.
 */

/**
 * Pending login attempts, by state. In memory on purpose — these are valid for
 * a couple of minutes and a restart mid-login should invalidate them rather
 * than leave a usable token-minting key lying in the database.
 */
const pending = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [state, at] of pending) if (now - at > STATE_TTL_MS) pending.delete(state);
}

/** Starts the flow: returns the URL the operator must open. */
async function beginLogin(req, res, next) {
  try {
    const missing = upstoxAuth.liveCredentialsMissing();
    if (missing.length) {
      res.status(409).json({
        status: 'error',
        message: `Live credentials not configured. Set ${missing.join(', ')} in the environment and restart.`,
      });
      return;
    }

    sweep();
    const state = crypto.randomBytes(24).toString('hex');
    pending.set(state, Date.now());

    res.json({
      status: 'ok',
      login_url: upstoxAuth.buildLoginUrl(state),
      redirect_uri: config.upstoxRedirectUri,
      expires_in_seconds: STATE_TTL_MS / 1000,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Where Upstox sends the operator back. Renders a plain HTML page because a
 * browser lands here directly, not the dashboard's fetch layer.
 */
async function handleCallback(req, res) {
  const { code, state } = req.query;

  const page = (ok, title, detail) =>
    res
      .status(ok ? 200 : 400)
      .type('html')
      .send(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
          `<title>${title}</title>` +
          `<style>body{font:15px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;background:#fafaf9;color:#0c0a09;` +
          `display:flex;min-height:100dvh;align-items:center;justify-content:center;margin:0;padding:24px}` +
          `div{max-width:32rem;background:#fff;border:1px solid #e7e5e4;border-radius:14px;padding:28px}` +
          `h1{font-size:1.05rem;margin:0 0 8px}p{margin:0;color:#57534e}` +
          `b{color:${ok ? '#047857' : '#b91c1c'}}</style>` +
          `<div><h1><b>${title}</b></h1><p>${detail}</p></div>`
      );

  if (!state || !pending.has(state)) {
    logger.warn({ hasState: Boolean(state) }, 'Upstox callback with an unknown state — refusing');
    return page(false, 'Login rejected', 'This link is expired or was not started from the dashboard. Begin the connection again from Settings.');
  }
  pending.delete(state);

  if (!code) {
    return page(false, 'Login failed', 'Upstox did not return an authorization code.');
  }

  try {
    const { expiresAt, userId } = await upstoxAuth.exchangeCode(code);
    const ist = expiresAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    logger.info({ userId }, 'Live Upstox connection established');
    return page(
      true,
      'Upstox connected',
      `Live trading is authenticated${userId ? ` as ${userId}` : ''}. This token is valid until <b>${ist} IST</b> — Upstox retires it at 03:30 every morning, so this has to be repeated each trading day. You can close this tab.`
    );
  } catch (err) {
    return page(false, 'Login failed', String(err.message).replace(/</g, '&lt;'));
  }
}

/** Token health, for the Settings page. Never returns the token itself. */
async function status(req, res, next) {
  try {
    res.json({ status: 'ok', live: await upstoxAuth.tokenStatus(LIVE), enabled: config.liveEnabled });
  } catch (err) {
    next(err);
  }
}

module.exports = { beginLogin, handleCallback, status };
