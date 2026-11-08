'use strict';

const axios = require('axios');
const config = require('../config/env');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');
const modes = require('../config/modes');
const upstoxAuth = require('./upstoxAuth');

/**
 * Talks to Upstox for both environments.
 *
 * WHY THERE IS NO MODULE-LEVEL CLIENT ANY MORE
 * This file used to build one axios instance at require() time with the token
 * baked into its headers. That is exactly what made 2 Sep 2026 unrecoverable
 * without a restart: the sandbox token expired at 03:30, a fresh one was put
 * in the environment, and the running process went on presenting the dead one
 * because the header had been captured hours earlier.
 *
 * Live makes that failure mode a daily certainty — its token expires every
 * morning at 03:30 IST. So the token is now fetched per request, from
 * services/upstoxAuth.js, which reads it from the database for live and from
 * the environment for paper.
 *
 * WHY TWO HOSTS
 * Live order WRITES go to api-hft.upstox.com while reads go to
 * api.upstox.com. Paper points both at the sandbox. config/modes.js owns that
 * mapping so nothing here branches on the mode name.
 */

/** Builds a request client for one call. Never cached — see the note above. */
async function clientFor(mode, kind) {
  const def = modes.resolve(mode);
  const token = await upstoxAuth.getAccessToken(def.mode);

  if (!token) {
    // A named, actionable failure instead of a 401 from the broker. The
    // difference matters: 401 sends you reading server logs, this sends you
    // to the Settings page to reconnect.
    const err = new Error(
      def.mode === modes.LIVE
        ? 'No valid live access token — reconnect Upstox from Settings (tokens expire 03:30 IST daily)'
        : 'No Upstox access token configured'
    );
    err.code = 'NO_TOKEN';
    throw err;
  }

  return axios.create({
    baseURL: kind === 'order' ? def.orderBaseUrl : def.dataBaseUrl,
    timeout: 10000,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(kind === 'order' ? modes.orderHeaders(def.mode) : {}),
    },
  });
}

/**
 * Places an order.
 *
 * For mode 'paper' this hits the Upstox SANDBOX, which validates the payload
 * and never executes it. For 'live' it hits the real order host and spends
 * real money.
 *
 * transactionType: 'BUY' | 'SELL'
 */
async function placeOrder({ instrumentToken, quantity, transactionType, product, orderType, price = 0, mode = modes.PAPER }) {
  if (!instrumentToken) {
    throw new Error('instrument_token is required to place an order (none provided in payload or DEFAULT_INSTRUMENT_TOKEN)');
  }
  if (!quantity || quantity <= 0) {
    throw new Error('quantity must be a positive number (none provided in payload or DEFAULT_QUANTITY)');
  }

  const def = modes.resolve(mode);
  const body = {
    quantity,
    product,
    validity: 'DAY',
    price: orderType === 'LIMIT' ? price : 0,
    tag: 'tv-upstox-bridge',
    instrument_token: instrumentToken,
    order_type: orderType,
    transaction_type: transactionType,
    disclosed_quantity: 0,
    trigger_price: 0,
    is_amo: false,
  };

  const label = `upstox[${def.mode}].placeOrder(${transactionType} ${instrumentToken})`;
  const client = await clientFor(def.mode, 'order');

  return withRetry(
    async (attempt) => {
      logger.info({ attempt, body, mode: def.mode, realMoney: def.realMoney }, `${label} — attempt ${attempt}`);
      const response = await client.post('/order/place', body);
      const orderId = response.data?.data?.order_id;
      if (!orderId) {
        // Upstox responded 2xx but without the field we need — treat as a
        // failure so it surfaces loudly instead of silently logging "success"
        // with no order_id to track.
        throw new Error(`Upstox order/place returned no order_id: ${JSON.stringify(response.data)}`);
      }
      logger.info({ orderId, transactionType, instrumentToken, mode: def.mode }, `${label} — success`);
      return { orderId, raw: response.data };
    },
    {
      retries: config.upstoxMaxRetries,
      baseDelayMs: config.upstoxRetryBaseDelayMs,
      label,
    }
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Asks the broker what actually happened to an order.
 *
 * PAPER: against the sandbox this returns "open pending" with average_price 0
 * and filled_quantity 0, permanently — the sandbox validates orders but never
 * executes them. The caller falls back to a market mark, which is why a paper
 * trade is recorded OPEN rather than FILLED.
 *
 * LIVE: a real fill exists, but not necessarily in the same millisecond that
 * place-order returned. Asking once and giving up would record a marked
 * ESTIMATE against a real trade — a number no contract note would agree with.
 * So live polls briefly (see fillPollAttempts in config/modes.js) before
 * conceding.
 *
 * Never throws: a failure to read back the order must not undo a position
 * that the broker may well have accepted.
 */
async function getOrderFill(orderId, mode = modes.PAPER) {
  const def = modes.resolve(mode);
  let last = { brokerStatus: 'unreadable', averagePrice: null, filledQuantity: 0, isFilled: false };

  for (let attempt = 1; attempt <= def.fillPollAttempts; attempt += 1) {
    try {
      const client = await clientFor(def.mode, 'data');
      const response = await client.get('/order/details', { params: { order_id: orderId } });
      const d = response.data?.data || {};
      const avg = Number(d.average_price);
      const filled = Number(d.filled_quantity);
      const isFilled = Number.isFinite(avg) && avg > 0 && Number.isFinite(filled) && filled > 0;

      last = {
        brokerStatus: d.status || 'unknown',
        averagePrice: isFilled ? avg : null,
        filledQuantity: Number.isFinite(filled) ? filled : 0,
        isFilled,
      };

      if (isFilled) {
        if (attempt > 1) logger.info({ orderId, attempt, mode: def.mode }, 'Broker reported the fill after polling');
        return last;
      }
      // A terminal state will never become filled — stop asking.
      if (['rejected', 'cancelled'].includes(String(d.status || '').toLowerCase())) return last;
    } catch (err) {
      logger.warn({ err: err.message, orderId, attempt, mode: def.mode }, 'Could not read back order status from Upstox');
    }

    if (attempt < def.fillPollAttempts) await sleep(def.fillPollDelayMs);
  }

  if (def.realMoney && !last.isFilled) {
    // On live this is serious: the trade will be priced from a mark instead of
    // the real fill, so every figure derived from it is an estimate.
    logger.error(
      { orderId, brokerStatus: last.brokerStatus, attempts: def.fillPollAttempts },
      'LIVE order never reported a fill — the recorded price will be a MARK, not the real fill'
    );
  }

  return last;
}

module.exports = { placeOrder, getOrderFill };
