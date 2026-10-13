'use strict';

/**
 * Health endpoint for Wispbyte uptime monitoring.
 *
 * The endpoint intentionally exposes only liveness and coarse counters. It
 * never returns environment values, guild identifiers, database identifiers,
 * or the gateway URL. Bind address and port come from the environment
 * (HEALTH_HOST / PORT); PORT 0 disables the listener.
 */

const http = require('http');

const { logger } = require('../utils/logger');

const log = logger.child('health');

let server = null;

/** Snapshot populated by the client once it is ready. */
const state = {
  ready: false,
  startedAt: Date.now(),
  guildCount: 0,
  latencyMs: null,
  version: null,
  shutdown: false,
};

/** Update the published state. Called from the client lifecycle. */
function update(patch) {
  Object.assign(state, patch);
}

/**
 * Build the health payload.
 * @returns {object}
 */
function payload() {
  const healthy = state.ready && !state.shutdown;
  return {
    status: healthy ? 'ok' : 'starting',
    uptimeSeconds: Math.floor((Date.now() - state.startedAt) / 1000),
    // Exposed as a boolean flag only; the sandbox uses it to stop routing.
    ready: state.ready,
    guilds: state.guildCount,
    latencyMs: state.latencyMs,
    // Respond with degraded when the gateway is unreachable for too long.
    degraded: Boolean(state.degraded),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Start the HTTP listener.
 * @param {{enabled: boolean, host: string, port: number}} config
 */
function start(config) {
  if (!config.enabled || config.port === 0) {
    log.info('Health endpoint disabled');
    return null;
  }

  server = http.createServer((request, response) => {
    const url = request.url || '/';

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'method_not_allowed' }));
      return;
    }

    if (url.startsWith('/health') || url === '/' || url.startsWith('/healthz')) {
      const body = JSON.stringify(payload());
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }

    // Anything else is a 404: there is no debug surface on this port.
    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ status: 'not_found' }));
  });

  server.on('error', (error) => {
    log.warn('Health endpoint error', { code: error && error.code });
  });

  server.listen(config.port, config.host, () => {
    log.info('Health endpoint listening', { host: config.host, port: config.port });
  });

  return server;
}

/** Stop the listener during shutdown. */
function stop() {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    server = null;
  });
}

module.exports = { start, stop, update, payload, state };
