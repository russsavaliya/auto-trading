'use strict';

const config = require('../config/env');

/**
 * Guards the /api/* admin dashboard routes. The frontend is a single-password
 * admin panel (no user accounts), so this just checks a shared secret sent as
 * a header — same shape as the webhook's checkSecret, but a separate secret
 * since the two audiences (TradingView vs. the dashboard operator) shouldn't
 * share one.
 */
function requireAdminPassword(req, res, next) {
  if (!config.adminPassword) {
    res.status(503).json({ status: 'error', message: 'Admin panel is not configured (ADMIN_PASSWORD unset)' });
    return;
  }

  const provided = req.header('x-admin-password');
  if (provided && provided === config.adminPassword) {
    next();
    return;
  }

  res.status(401).json({ status: 'error', message: 'Unauthorized' });
}

module.exports = { requireAdminPassword };
