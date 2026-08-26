'use strict';

const logger = require('./logger');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` with retries + exponential backoff, but only for failures that
 * are plausibly transient (network errors, timeouts, 5xx). A 4xx means
 * Upstox understood and rejected the request (bad instrument_token, bad
 * quantity, insufficient margin, etc.) — retrying that just wastes time and
 * risks confusing logs, so those fail immediately.
 *
 * @param {Function} fn - async function to attempt. Receives the attempt number (1-based).
 * @param {Object} opts
 * @param {number} opts.retries - number of retries AFTER the first attempt.
 * @param {number} opts.baseDelayMs - base delay for exponential backoff.
 * @param {string} opts.label - for logging.
 */
async function withRetry(fn, { retries, baseDelayMs, label = 'operation' }) {
  const maxAttempts = retries + 1;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      const isClientError = status !== undefined && status >= 400 && status < 500;

      if (isClientError) {
        logger.error({ label, attempt, status, data: err.response?.data }, `${label} failed with a client error — not retrying`);
        throw err;
      }

      if (attempt === maxAttempts) {
        logger.error({ label, attempt, err: err.message }, `${label} failed after ${maxAttempts} attempt(s) — giving up`);
        throw err;
      }

      const delay = baseDelayMs * 2 ** (attempt - 1);
      logger.warn({ label, attempt, delay, err: err.message }, `${label} failed, retrying in ${delay}ms`);
      await sleep(delay);
    }
  }

  // Unreachable, but keeps linters happy.
  throw lastError;
}

module.exports = { withRetry };
