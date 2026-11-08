'use strict';

const config = require('./env');

/**
 * The two trading environments, and every way they differ.
 *
 * WHY THIS FILE EXISTS
 * Paper and live are not "the same code with a different URL". They differ in
 * where orders go, where the token comes from, how long that token lives, how
 * a fill is priced, and what happens when something breaks. Scattering those
 * five differences across the services is how you end up placing a real order
 * against a sandbox assumption. They are all here instead, and every service
 * asks this file rather than branching on `mode === 'live'` itself.
 *
 * PAPER IS THE DEFAULT EVERYWHERE. Every function that takes a mode defaults
 * it to 'paper', so a code path that was missed when live was added keeps
 * doing what it does today instead of quietly touching real money.
 */

const PAPER = 'paper';
const LIVE = 'live';
const MODES = [PAPER, LIVE];

/**
 * Live splits order WRITES onto a different host from everything else.
 * Upstox's place-order documentation gives `api-hft.upstox.com` while the
 * order-details page gives `api.upstox.com`, so the two cannot share one base
 * URL the way the sandbox does.
 *
 * Both are overridable by env because those two doc pages disagree and this
 * has to be confirmed against a real account before the first live order —
 * see docs/GO_LIVE.md §3.1. Getting it wrong should be a config edit, not a
 * code change made in a hurry on a trading morning.
 */
const LIVE_ORDER_HOST = (process.env.UPSTOX_LIVE_ORDER_BASE_URL || 'https://api-hft.upstox.com/v2').replace(/\/+$/, '');
const LIVE_DATA_HOST = (process.env.UPSTOX_LIVE_API_BASE_URL || 'https://api.upstox.com/v2').replace(/\/+$/, '');

const DEFINITIONS = {
  [PAPER]: {
    mode: PAPER,
    label: 'Paper',
    /** Sandbox validates the order and never fills it. */
    orderBaseUrl: config.upstoxApiBaseUrl,
    dataBaseUrl: config.upstoxApiBaseUrl,
    /**
     * A single long-lived token in the environment. The sandbox token issued
     * 3 Aug 2026 lasted until 2 Sep — roughly 30 days.
     */
    tokenSource: 'env',
    /**
     * The sandbox never fills anything, so a fill has to be marked against the
     * option's real traded price with slippage charged on both legs. See
     * services/marketData.js.
     */
    fillsFromBroker: false,
    /** How long to wait for the broker to report a fill. Pointless here. */
    fillPollAttempts: 1,
    fillPollDelayMs: 0,
    /** Losing this costs nothing real, so it may fail loudly and carry on. */
    realMoney: false,
  },

  [LIVE]: {
    mode: LIVE,
    label: 'Live',
    orderBaseUrl: LIVE_ORDER_HOST,
    dataBaseUrl: LIVE_DATA_HOST,
    /**
     * Read fresh from broker_tokens on every request. The live token dies at
     * 3:30 AM IST daily regardless of when it was issued, so it cannot be
     * captured at module load the way the sandbox one was — that is exactly
     * what turned 2 Sep 2026 into six hours of silent 401s.
     */
    tokenSource: 'db',
    /** Real fills exist and must always win over a mark. */
    fillsFromBroker: true,
    /**
     * A live MARKET order is not filled the instant place-order returns.
     * Asking once and falling back to a mark would record an estimate on a
     * real trade — so poll briefly before giving up.
     */
    fillPollAttempts: 6,
    fillPollDelayMs: 400,
    realMoney: true,
  },
};

function isMode(value) {
  return MODES.includes(value);
}

/** Never throws on a bad value — an unknown mode resolves to paper. */
function resolve(mode) {
  return DEFINITIONS[isMode(mode) ? mode : PAPER];
}

/**
 * Extra headers Upstox requires from an Algo App. The name (not the ID) is
 * what goes in the header; SEBI's traceability rules make it mandatory on
 * order placement once an app is registered as an algo.
 */
function orderHeaders(mode) {
  if (mode !== LIVE) return {};
  return config.upstoxAlgoName ? { 'X-Algo-Name': config.upstoxAlgoName } : {};
}

module.exports = { PAPER, LIVE, MODES, DEFINITIONS, isMode, resolve, orderHeaders };
