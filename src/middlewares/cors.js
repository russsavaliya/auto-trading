'use strict';

const config = require('../config/env');

/**
 * CORS for the admin dashboard frontend only — the webhook endpoint doesn't
 * need it (TradingView calls it server-to-server, not from a browser).
 */
function corsForAdmin(req, res, next) {
  const origin = config.adminAllowedOrigin || '*';
  res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-password');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}

module.exports = corsForAdmin;
