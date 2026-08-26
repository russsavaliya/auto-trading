'use strict';

const config = require('../config/env');

/**
 * Login: the frontend only holds a password (from its own env), it never
 * stores a session server-side — this just confirms the password is right
 * before the frontend starts sending it as a header on every request.
 */
function login(req, res) {
  const { password } = req.body || {};
  if (!config.adminPassword) {
    res.status(503).json({ status: 'error', message: 'Admin panel is not configured' });
    return;
  }
  if (password && password === config.adminPassword) {
    res.json({ status: 'ok' });
    return;
  }
  res.status(401).json({ status: 'error', message: 'Invalid password' });
}

module.exports = { login };
