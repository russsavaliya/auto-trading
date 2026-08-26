'use strict';

const supabaseService = require('../services/supabaseService');

async function listPositions(req, res, next) {
  try {
    const positions = await supabaseService.listPositionStates();
    res.json({ status: 'ok', positions });
  } catch (err) {
    next(err);
  }
}

module.exports = { listPositions };
