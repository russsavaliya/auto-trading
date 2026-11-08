'use strict';

const supabaseService = require('../services/supabaseService');

async function listPositions(req, res, next) {
  try {
    const positions = await supabaseService.listPositionStates(req.mode);
    res.json({ status: 'ok', mode: req.mode, positions });
  } catch (err) {
    next(err);
  }
}

module.exports = { listPositions };
