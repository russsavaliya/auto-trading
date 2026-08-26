'use strict';

const express = require('express');
const validateWebhook = require('../middlewares/validateWebhook');
const webhookController = require('../controllers/webhook.controller');

const router = express.Router();

router.post('/tradingview', validateWebhook, webhookController.handleTradingViewAlert);

module.exports = router;
