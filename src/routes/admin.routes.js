'use strict';

const express = require('express');
const { requireAdminPassword } = require('../middlewares/adminAuth');
const authController = require('../controllers/auth.controller');
const configController = require('../controllers/config.controller');
const webhookLogsController = require('../controllers/webhookLogs.controller');
const tradesController = require('../controllers/trades.controller');
const positionsController = require('../controllers/positions.controller');
const pnlController = require('../controllers/pnl.controller');

const router = express.Router();

// Public — this is how the dashboard checks the password before it starts
// sending it as a header, so it must sit ABOVE requireAdminPassword.
router.post('/login', authController.login);

router.use(requireAdminPassword);

router.get('/config', configController.getConfig);
router.patch('/config', configController.updateConfig);

router.get('/webhook-logs', webhookLogsController.listWebhookLogs);

// `/trades/running` must be registered before any `/trades/:id` route is ever
// added, or "running" would be swallowed as an id.
router.get('/trades/running', tradesController.listRunningTrades);
router.get('/trades', tradesController.listTrades);

router.get('/positions', positionsController.listPositions);

router.get('/pnl/summary', pnlController.getSummary);
router.get('/pnl/monthly', pnlController.getMonthly);
router.get('/pnl/daily', pnlController.getDaily);
router.get('/pnl/report', pnlController.getReport);

module.exports = router;
