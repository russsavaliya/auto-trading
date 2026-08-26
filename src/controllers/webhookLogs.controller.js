'use strict';

const supabaseService = require('../services/supabaseService');

async function listWebhookLogs(req, res, next) {
  try {
    const { processed: processedRaw, limit: limitRaw, offset: offsetRaw } = req.query;
    const processed = processedRaw === undefined ? undefined : processedRaw === 'true';
    const limit = Math.min(parseInt(limitRaw, 10) || 50, 200);
    const offset = parseInt(offsetRaw, 10) || 0;
    const { logs, total } = await supabaseService.listWebhookLogs({ processed, limit, offset });
    res.json({ status: 'ok', logs, total });
  } catch (err) {
    next(err);
  }
}

module.exports = { listWebhookLogs };
