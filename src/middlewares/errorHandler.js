'use strict';

const logger = require('../utils/logger');

/**
 * Final safety net: catches anything thrown synchronously or passed to
 * next(err) that slipped past the controller-level try/catch, so a bug never
 * takes the whole process down mid-trading-session.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  logger.error({ err: err.message, stack: err.stack }, 'Unhandled error reached top-level error handler');
  res.status(500).json({ status: 'error', message: 'Internal server error' });
}

module.exports = errorHandler;
