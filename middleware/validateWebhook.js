'use strict';

const config = require('../config/env');
const logger = require('../utils/logger');
const supabaseService = require('../services/supabaseService');

const VALID_SIGNAL_TYPES = ['CALL_ENTRY', 'CALL_EXIT', 'PUT_ENTRY', 'PUT_EXIT'];

function validatePayloadShape(body) {
  const errors = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: ['Request body must be a JSON object'] };
  }

  if (!body.signal_type || !VALID_SIGNAL_TYPES.includes(body.signal_type)) {
    errors.push(`signal_type must be one of ${VALID_SIGNAL_TYPES.join(', ')}`);
  }
  if (!body.symbol || typeof body.symbol !== 'string' || body.symbol.trim() === '') {
    errors.push('symbol is required and must be a non-empty string');
  }
  if (body.price === undefined || body.price === null || Number.isNaN(Number(body.price)) || Number(body.price) <= 0) {
    errors.push('price is required and must be a positive number');
  }
  if (body.score === undefined || body.score === null || Number.isNaN(Number(body.score))) {
    errors.push('score is required and must be a number');
  }
  if (!body.timestamp) {
    errors.push('timestamp is required');
  }
  if (!body.alert_id || typeof body.alert_id !== 'string' || body.alert_id.trim() === '') {
    errors.push('alert_id is required and must be a non-empty string');
  }
  if (body.quantity !== undefined && (Number.isNaN(Number(body.quantity)) || Number(body.quantity) <= 0)) {
    errors.push('quantity, if provided, must be a positive number');
  }

  return { errors };
}

function checkSecret(req) {
  if (!config.webhookSecret) return true; // no secret configured — local/dev only, warned at startup
  const headerSecret = req.get('x-webhook-secret');
  const querySecret = req.query.token;
  return headerSecret === config.webhookSecret || querySecret === config.webhookSecret;
}

/**
 * Runs for every POST to /webhook/tradingview. Order matters:
 *   1. Log the raw request immediately (webhook_log), before any rejection,
 *      so every hit to this endpoint is auditable — including malformed or
 *      unauthenticated ones.
 *   2. Verify the shared secret, to filter out anyone who isn't TradingView.
 *   3. Validate the payload shape, to reject malformed bodies with a 400
 *      instead of letting bad data reach order-placement logic.
 * The webhook_log row's id is attached to req so the route handler updates
 * the SAME row as processing continues, rather than creating duplicate rows.
 */
async function validateWebhook(req, res, next) {
  const webhookLogId = await supabaseService.insertWebhookLog(req.body);
  req.webhookLogId = webhookLogId;

  if (!checkSecret(req)) {
    logger.warn({ ip: req.ip }, 'Webhook rejected: invalid or missing shared secret');
    await supabaseService.updateWebhookLog(webhookLogId, { processed: false, reason: 'invalid_secret' });
    return res.status(401).json({ status: 'error', message: 'Invalid or missing webhook secret' });
  }

  const { errors } = validatePayloadShape(req.body);
  if (errors.length > 0) {
    logger.warn({ errors, body: req.body }, 'Webhook rejected: payload validation failed');
    await supabaseService.updateWebhookLog(webhookLogId, {
      processed: false,
      reason: `validation_failed: ${errors.join('; ')}`,
    });
    return res.status(400).json({ status: 'error', message: 'Invalid payload', errors });
  }

  req.webhookPayload = {
    signalType: req.body.signal_type,
    symbol: String(req.body.symbol).trim(),
    price: Number(req.body.price),
    score: Number(req.body.score),
    timestamp: req.body.timestamp,
    alertId: String(req.body.alert_id).trim(),
    instrumentToken: req.body.instrument_token || config.defaultInstrumentToken || null,
    quantity: req.body.quantity ? Number(req.body.quantity) : config.defaultQuantity,
    product: req.body.product || config.defaultProduct,
    orderType: req.body.order_type || config.defaultOrderType,
  };

  logger.info({ webhookLogId, payload: req.webhookPayload }, 'Webhook received and validated');
  next();
}

module.exports = validateWebhook;
