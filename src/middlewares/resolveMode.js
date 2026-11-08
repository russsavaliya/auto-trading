'use strict';

const modes = require('../config/modes');

/**
 * Reads `?mode=` off an admin request and puts a validated value on `req`.
 *
 * Unknown or absent values resolve to PAPER rather than erroring. Every read
 * endpoint on this dashboard answers a question about money, and answering it
 * about the wrong environment is worse than answering it about the safe one —
 * a caller that forgets the parameter sees paper, never live.
 */
function resolveMode(req, _res, next) {
  const raw = req.query.mode;
  req.mode = modes.isMode(raw) ? raw : modes.PAPER;
  next();
}

module.exports = { resolveMode };
