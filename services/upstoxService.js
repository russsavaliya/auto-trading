'use strict';

const axios = require('axios');
const config = require('../config/env');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');

const client = axios.create({
  baseURL: config.upstoxApiBaseUrl,
  timeout: 10000,
  headers: {
    Authorization: `Bearer ${config.upstoxAccessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
});

/**
 * Places an order against the Upstox SANDBOX API. This function never
 * touches a live endpoint — config.upstoxApiBaseUrl comes solely from
 * UPSTOX_API_BASE_URL, which must be set to Upstox's sandbox host.
 *
 * transactionType: 'BUY' | 'SELL'
 */
async function placeOrder({ instrumentToken, quantity, transactionType, product, orderType, price = 0 }) {
  if (!instrumentToken) {
    throw new Error('instrument_token is required to place an order (none provided in payload or DEFAULT_INSTRUMENT_TOKEN)');
  }
  if (!quantity || quantity <= 0) {
    throw new Error('quantity must be a positive number (none provided in payload or DEFAULT_QUANTITY)');
  }

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

  const label = `upstox.placeOrder(${transactionType} ${instrumentToken})`;

  return withRetry(
    async (attempt) => {
      logger.info({ attempt, body }, `${label} — attempt ${attempt}`);
      const response = await client.post('/order/place', body);
      const orderId = response.data?.data?.order_id;
      if (!orderId) {
        // Upstox responded 2xx but without the field we need — treat as a
        // failure so it surfaces loudly instead of silently logging "success"
        // with no order_id to track.
        throw new Error(`Upstox order/place returned no order_id: ${JSON.stringify(response.data)}`);
      }
      logger.info({ orderId, transactionType, instrumentToken }, `${label} — success`);
      return { orderId, raw: response.data };
    },
    {
      retries: config.upstoxMaxRetries,
      baseDelayMs: config.upstoxRetryBaseDelayMs,
      label,
    }
  );
}

module.exports = { placeOrder };
