'use strict';

const supabaseService = require('../services/supabaseService');

async function listWebhookLogs(req, res, next) {
  try {
    const { processed: processedRaw, limit: limitRaw, offset: offsetRaw } = req.query;
    const processed = processedRaw === undefined ? undefined : processedRaw === 'true';
    const limit = Math.min(parseInt(limitRaw, 10) || 50, 200);
    const offset = parseInt(offsetRaw, 10) || 0;
    const { logs, total } = await supabaseService.listWebhookLogs({ processed, limit, offset });

    // One inbound call, two outcomes. `processed`/`reason` are the paper
    // result and stay untouched so nothing that already reads them breaks;
    // the requested mode is projected onto neutral field names so the UI can
    // render either environment without knowing the column layout.
    const projected = logs.map((l) => ({
      ...l,
      outcome_processed: req.mode === 'live' ? l.live_processed : l.processed,
      outcome_reason: req.mode === 'live' ? l.live_reason : l.reason,
    }));

    res.json({ status: 'ok', mode: req.mode, logs: projected, total });
  } catch (err) {
    next(err);
  }
}

module.exports = { listWebhookLogs };
