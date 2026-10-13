'use strict';

/**
 * Thin HTTP client used for every call to the Cloudflare Worker gateway.
 *
 * Responsibilities:
 *   - attach the bearer token without ever logging it
 *   - enforce a per-request timeout with AbortController
 *   - retry idempotent failures with exponential backoff and jitter
 *   - normalize failures into DatabaseError with redacted context
 *
 * The bot never talks to Cloudflare D1 directly: D1 is only reachable from the
 * Worker, which is the sole holder of the database binding.
 */

const { logger } = require('../utils/logger');
const { DatabaseError } = require('../utils/errors');

const log = logger.child('gateway');

/** HTTP methods that are safe to retry automatically. */
const RETRYABLE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Status codes worth retrying. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Backoff for attempt N (0-based): 300ms, 900ms, 2700ms with jitter.
 * @param {number} attempt
 * @returns {number}
 */
function backoffMs(attempt) {
  const base = 300 * (3 ** attempt);
  const jitter = Math.floor(Math.random() * 150);
  return Math.min(base + jitter, 8000);
}

class HttpClient {
  /**
   * @param {{baseUrl: string, authToken: string, timeoutMs: number, maxRetries: number}} options
   */
  constructor(options) {
    this.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    this.authToken = String(options.authToken || '');
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 10000;
    this.maxRetries = Number.isFinite(options.maxRetries) ? Math.max(0, options.maxRetries) : 3;
  }

  /** True when the client has enough configuration to issue requests. */
  isConfigured() {
    return Boolean(this.baseUrl && this.authToken);
  }

  /**
   * Perform a request against the gateway.
   *
   * @param {string} method
   * @param {string} endpoint  path beginning with a slash, e.g. "/v1/guilds/1/config"
   * @param {{query?: object, body?: object, retries?: number}} [options]
   * @returns {Promise<object>} parsed JSON body, or { } for empty 204 responses
   */
  async request(method, endpoint, options = {}) {
    if (!this.isConfigured()) {
      throw new DatabaseError('Gateway is not configured', { code: 'GATEWAY_UNCONFIGURED' });
    }

    const url = new URL(`${this.baseUrl}${endpoint}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, String(value));
      }
    }

    const upperMethod = method.toUpperCase();
    const retryableByMethod = RETRYABLE_METHODS.has(upperMethod);
    const configuredRetries = options.retries !== undefined ? options.retries : this.maxRetries;
    // Non-idempotent writes are retried only on transport errors, never on a
    // received status code, so a duplicate case cannot be created by a retry.
    const maxAttempts = (retryableByMethod ? configuredRetries : 0) + 1;

    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const headers = {
          Authorization: `Bearer ${this.authToken}`,
          Accept: 'application/json',
          'User-Agent': 'moderation-bot',
        };
        const init = { method: upperMethod, headers, signal: controller.signal };

        if (options.body !== undefined) {
          headers['Content-Type'] = 'application/json';
          init.body = JSON.stringify(options.body);
        }

        const response = await fetch(url, init);
        const text = await response.text();
        let payload = null;
        if (text) {
          try {
            payload = JSON.parse(text);
          } catch {
            payload = null;
          }
        }

        if (response.ok) {
          return payload === null ? {} : payload;
        }

        // The gateway returns { error: { code, message } } for known failures.
        const code = payload && payload.error && payload.error.code ? payload.error.code : `HTTP_${response.status}`;
        const message = payload && payload.error && payload.error.message
          ? payload.error.message
          : 'Gateway request failed';
        const retryAfter = Number.parseInt(response.headers.get('retry-after') || '0', 10);

        const error = new DatabaseError(message, { code, status: response.status, details: { endpoint, method: upperMethod } });
        lastError = error;

        const shouldRetry = retryableByMethod && RETRYABLE_STATUS.has(response.status) && attempt < maxAttempts - 1;
        if (!shouldRetry) {
          log.warn('Gateway request failed', { endpoint, method: upperMethod, status: response.status, code });
          throw error;
        }

        const delay = retryAfter > 0 ? Math.min(retryAfter * 1000, 8000) : backoffMs(attempt);
        log.debug('Retrying gateway request', { endpoint, method: upperMethod, status: response.status, attempt: attempt + 1, delay });
        await sleep(delay);
      } catch (error) {
        if (error instanceof DatabaseError && error.status) {
          // Already handled above (non-retryable status received).
          throw error;
        }

        const aborted = error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
        lastError = new DatabaseError(
          aborted ? 'Gateway request timed out' : 'Gateway request could not be completed',
          {
            code: aborted ? 'GATEWAY_TIMEOUT' : 'GATEWAY_UNREACHABLE',
            details: { endpoint, method: upperMethod },
          },
        );

        if (attempt >= maxAttempts - 1) {
          log.warn('Gateway unreachable', { endpoint, method: upperMethod, aborted });
          throw lastError;
        }

        await sleep(backoffMs(attempt));
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError || new DatabaseError('Gateway request failed', { code: 'GATEWAY_UNKNOWN' });
  }

  get(endpoint, options) {
    return this.request('GET', endpoint, options);
  }

  post(endpoint, body, options = {}) {
    return this.request('POST', endpoint, { ...options, body });
  }

  put(endpoint, body, options = {}) {
    return this.request('PUT', endpoint, { ...options, body });
  }

  patch(endpoint, body, options = {}) {
    return this.request('PATCH', endpoint, { ...options, body });
  }

  delete(endpoint, options = {}) {
    return this.request('DELETE', endpoint, options);
  }
}

module.exports = { HttpClient };
