'use strict';

function notFound(req, res) {
  res.status(404).json({ status: 'error', message: 'Not found' });
}

module.exports = notFound;
