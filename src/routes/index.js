'use strict';

const express = require('express');
const corsForAdmin = require('../middlewares/cors');
const healthRoutes = require('./health.routes');
const webhookRoutes = require('./webhook.routes');
const adminRoutes = require('./admin.routes');

const router = express.Router();

router.use(healthRoutes);

// TradingView calls the webhook server-to-server, so only the admin dashboard
// needs CORS — it is scoped to /api rather than applied app-wide.
router.use('/api', corsForAdmin);

router.use('/webhook', webhookRoutes);
router.use('/api', adminRoutes);

module.exports = router;
