/**
 * Moderation gateway - Cloudflare Worker entry point.
 *
 * Purpose: expose a small, authenticated HTTP API that gives the Discord bot
 * controlled access to Cloudflare D1. D1 has no public network endpoint, so the
 * Worker is the only component that touches the database binding. Everything is
 * gated on a shared bearer token held in a Worker secret.
 *
 * Design notes:
 *   - The route table is explicit: method plus regular expression. There is no
 *     dynamic dispatch, so a malformed path can never reach a handler.
 *   - Requests are rejected before any database access when unauthorized.
 *   - Errors are mapped to generic payloads. SQL text, binding names, token
 *     values, and stack traces never leave the worker.
 *   - No CORS headers are returned; this API is not intended for browsers.
 */

import { errors, isAuthorized, readJson, ok } from './core/http.js';
import { ValidationError } from './core/validate.js';
import { StorageError, rateLimit } from './core/db.js';

import * as botRoutes from './routes/bot.js';
import * as guildRoutes from './routes/guilds.js';
import * as caseRoutes from './routes/cases.js';
import * as moderationRoutes from './routes/moderation.js';
import * as settingsRoutes from './routes/settings.js';
import * as taskRoutes from './routes/tasks.js';

/**
 * Route table. Patterns are anchored and use \d+ for identifiers, so
 * "/v1/guilds/abc/config" cannot match a route that expects a snowflake.
 */
const ROUTES = [
  // Public: liveness only.
  { method: 'GET', pattern: /^\/health$/, handler: botRoutes.health, public: true },

  // Authenticated: readiness and heartbeat.
  { method: 'GET', pattern: /^\/v1\/health$/, handler: botRoutes.readiness },
  { method: 'GET', pattern: /^\/v1\/bot\/status$/, handler: botRoutes.status },
  { method: 'POST', pattern: /^\/v1\/bot\/heartbeat$/, handler: botRoutes.heartbeat },

  // Guild configuration.
  { method: 'GET', pattern: /^\/v1\/guilds\/(\d{17,20})\/config$/, handler: guildRoutes.getConfig, params: ['guildId'] },
  { method: 'PUT', pattern: /^\/v1\/guilds\/(\d{17,20})\/config$/, handler: guildRoutes.putConfig, params: ['guildId'], body: true },
  { method: 'GET', pattern: /^\/v1\/guilds\/(\d{17,20})\/stats$/, handler: guildRoutes.stats, params: ['guildId'] },
  { method: 'DELETE', pattern: /^\/v1\/guilds\/(\d{17,20})$/, handler: guildRoutes.remove, params: ['guildId'] },

  // Cases.
  { method: 'POST', pattern: /^\/v1\/guilds\/(\d{17,20})\/cases$/, handler: caseRoutes.create, params: ['guildId'], body: true },
  { method: 'GET', pattern: /^\/v1\/guilds\/(\d{17,20})\/cases\/export$/, handler: caseRoutes.exportAll, params: ['guildId'] },
  { method: 'GET', pattern: /^\/v1\/guilds\/(\d{17,20})\/cases$/, handler: caseRoutes.list, params: ['guildId'] },
  { method: 'GET', pattern: /^\/v1\/guilds\/(\d{17,20})\/cases\/(\d+)$/, handler: caseRoutes.getOne, params: ['guildId', 'caseNumber'] },
  { method: 'PATCH', pattern: /^\/v1\/guilds\/(\d{17,20})\/cases\/(\d+)$/, handler: caseRoutes.patch, params: ['guildId', 'caseNumber'], body: true },

  // Warnings.
  { method: 'GET', pattern: /^\/v1\/guilds\/(\d{17,20})\/warnings\/count$/, handler: moderationRoutes.warningsCount, params: ['guildId'] },
  { method: 'GET', pattern: /^\/v1\/guilds\/(\d{17,20})\/warnings$/, handler: moderationRoutes.warningsList, params: ['guildId'] },
  { method: 'POST', pattern: /^\/v1\/guilds\/(\d{17,20})\/warnings\/clear$/, handler: moderationRoutes.warningsClear, params: ['guildId'], body: true },
  { method: 'DELETE', pattern: /^\/v1\/guilds\/(\d{17,20})\/warnings\/(\d+)$/, handler: moderationRoutes.warningsDelete, params: ['guildId', 'warningId'] },
  { method: 'PATCH', pattern: /^\/v1\/guilds\/(\d{17,20})\/warnings\/(\d+)$/, handler: moderationRoutes.warningsPatch, params: ['guildId', 'warningId'], body: true },

  // Notes.
  { method: 'GET', pattern: /^\/v1\/guilds\/(\d{17,20})\/notes$/, handler: moderationRoutes.notesList, params: ['guildId'] },
  { method: 'POST', pattern: /^\/v1\/guilds\/(\d{17,20})\/notes$/, handler: moderationRoutes.notesCreate, params: ['guildId'], body: true },
  { method: 'DELETE', pattern: /^\/v1\/guilds\/(\d{17,20})\/notes\/(\d+)$/, handler: moderationRoutes.notesDelete, params: ['guildId', 'noteId'] },

  // Punishment state.
  { method: 'GET', pattern: /^\/v1\/guilds\/(\d{17,20})\/punishments$/, handler: moderationRoutes.punishmentsList, params: ['guildId'] },
  { method: 'POST', pattern: /^\/v1\/guilds\/(\d{17,20})\/punishments$/, handler: moderationRoutes.punishmentsSet, params: ['guildId'], body: true },
  { method: 'POST', pattern: /^\/v1\/guilds\/(\d{17,20})\/punishments\/clear$/, handler: moderationRoutes.punishmentsClear, params: ['guildId'], body: true },

  // Automod strikes.
  { method: 'GET', pattern: /^\/v1\/guilds\/(\d{17,20})\/strikes$/, handler: moderationRoutes.strikesGet, params: ['guildId'] },
  { method: 'POST', pattern: /^\/v1\/guilds\/(\d{17,20})\/strikes$/, handler: moderationRoutes.strikesAdd, params: ['guildId'], body: true },
  { method: 'POST', pattern: /^\/v1\/guilds\/(\d{17,20})\/strikes\/reset$/, handler: moderationRoutes.strikesReset, params: ['guildId'], body: true },

  // Settings.
  { method: 'GET', pattern: /^\/v1\/guilds\/(\d{17,20})\/automod$/, handler: settingsRoutes.getAutomod, params: ['guildId'] },
  { method: 'PUT', pattern: /^\/v1\/guilds\/(\d{17,20})\/automod$/, handler: settingsRoutes.putAutomod, params: ['guildId'], body: true },
  { method: 'GET', pattern: /^\/v1\/guilds\/(\d{17,20})\/logging$/, handler: settingsRoutes.getLogging, params: ['guildId'] },
  { method: 'PUT', pattern: /^\/v1\/guilds\/(\d{17,20})\/logging$/, handler: settingsRoutes.putLogging, params: ['guildId'], body: true },

  // Scheduled tasks.
  { method: 'POST', pattern: /^\/v1\/tasks\/claim$/, handler: taskRoutes.claim, body: true },
  { method: 'GET', pattern: /^\/v1\/guilds\/(\d{17,20})\/tasks$/, handler: taskRoutes.list, params: ['guildId'] },
  { method: 'POST', pattern: /^\/v1\/guilds\/(\d{17,20})\/tasks$/, handler: taskRoutes.create, params: ['guildId'], body: true },
  { method: 'POST', pattern: /^\/v1\/guilds\/(\d{17,20})\/tasks\/cancel$/, handler: taskRoutes.cancel, params: ['guildId'], body: true },
  { method: 'POST', pattern: /^\/v1\/guilds\/(\d{17,20})\/tasks\/(\d+)\/complete$/, handler: taskRoutes.complete, params: ['guildId', 'taskId'], body: true },
];

/**
 * Resolve the client identity used for rate limiting.
 * Uses a short hash of the presented token, so limits are per client secret
 * rather than per IP (Discord egress IPs are shared and would false-positive).
 */
async function clientKey(request) {
  const header = request.headers.get('Authorization') || 'anonymous';
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(header));
    const bytes = new Uint8Array(digest).slice(0, 8);
    return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return 'anonymous';
  }
}

/** Match a request against the route table. */
function matchRoute(method, pathname) {
  let methodMismatch = false;
  for (const route of ROUTES) {
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    if (route.method !== method) {
      methodMismatch = true;
      continue;
    }
    const params = {};
    (route.params || []).forEach((name, index) => {
      params[name] = match[index + 1];
    });
    return { route, params };
  }
  return { route: null, methodMismatch };
}

export default {
  /**
   * @param {Request} request
   * @param {{DB: D1Database, KV?: KVNamespace, WORKER_AUTH_TOKEN?: string,
   *          RATE_LIMIT_PER_MINUTE?: string, CONFIG_CACHE_SECONDS?: string,
   *          MAX_BODY_BYTES?: string}} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    // Reject anything that is not a plain request to a known path early.
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      return errors.methodNotAllowed();
    }

    const { route, params, methodMismatch } = matchRoute(method, url.pathname);
    if (!route) {
      return methodMismatch ? errors.methodNotAllowed() : errors.notFound();
    }

    if (!route.public && !isAuthorized(request, env.WORKER_AUTH_TOKEN)) {
      // Deliberately identical response for missing, malformed, and wrong
      // tokens: no signal about which part was incorrect.
      return errors.unauthorized();
    }

    if (!route.public) {
      const limitPerMinute = Number.parseInt(env.RATE_LIMIT_PER_MINUTE || '600', 10);
      const key = await clientKey(request);
      const limit = await rateLimit(env, key, Number.isFinite(limitPerMinute) ? limitPerMinute : 600);
      if (!limit.allowed) return errors.rateLimited(limit.retryAfter);
    }

    const maxBodyBytes = Number.parseInt(env.MAX_BODY_BYTES || '262144', 10);
    let body = null;
    if (route.body) {
      const parsed = await readJson(request, Number.isFinite(maxBodyBytes) ? maxBodyBytes : 262144);
      if (!parsed.ok) return parsed.response;
      body = parsed.value;
    }

    const handlerCtx = { request, env, url, params, body, ctx };

    try {
      return await route.handler(handlerCtx);
    } catch (error) {
      if (error instanceof ValidationError) {
        // Validation messages name the offending field only: safe to return.
        return errors.invalidPayload(error.message);
      }
      if (error instanceof StorageError) {
        console.error('storage_error', { path: url.pathname, method });
        return errors.internal();
      }
      // Unexpected failure: log the message shape only, never the payload.
      console.error('unhandled_error', { path: url.pathname, method, name: error && error.name });
      return errors.internal();
    }
  },
};
