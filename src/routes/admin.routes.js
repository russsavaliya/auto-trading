'use strict';

const express = require('express');
const { requireAdminPassword } = require('../middlewares/adminAuth');
const authController = require('../controllers/auth.controller');
const configController = require('../controllers/config.controller');
const webhookLogsController = require('../controllers/webhookLogs.controller');
const tradesController = require('../controllers/trades.controller');
const positionsController = require('../controllers/positions.controller');
const pnlController = require('../controllers/pnl.controller');
const upstoxAuthController = require('../controllers/upstoxAuth.controller');
const { resolveMode } = require('../middlewares/resolveMode');

const router = express.Router();

// Public — this is how the dashboard checks the password before it starts
// sending it as a header, so it must sit ABOVE requireAdminPassword.
router.post('/login', authController.login);

// Also public, and it HAS to be: Upstox redirects the operator's browser
// here, and that browser does not send an x-admin-password header. The
// single-use `state` minted by /upstox/login is what guards it instead —
// see controllers/upstoxAuth.controller.js.
router.get('/upstox/callback', upstoxAuthController.handleCallback);

router.use(requireAdminPassword);

// Every read below answers a question about one environment. resolveMode
// validates ?mode= and defaults it to paper, so a caller that forgets the
// parameter can only ever see the harmless one.
router.use(resolveMode);

router.post('/upstox/login', upstoxAuthController.beginLogin);
router.get('/upstox/status', upstoxAuthController.status);

router.get('/config', configController.getConfig);
router.patch('/config', configController.updateConfig);

router.get('/webhook-logs', webhookLogsController.listWebhookLogs);

// `/trades/running` must be registered before any `/trades/:id` route is ever
// added, or "running" would be swallowed as an id.
router.get('/trades/running', tradesController.listRunningTrades);
router.get('/trades', tradesController.listTrades);

router.get('/positions', positionsController.listPositions);

router.get('/pnl/summary', pnlController.getSummary);
router.get('/pnl/daily', pnlController.getDaily);
router.get('/pnl/report', pnlController.getReport);

module.exports = router;
