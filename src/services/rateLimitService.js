'use strict';

/**
 * In-process command rate limiting.
 *
 * This protects the bot and the Cloudflare gateway from command abuse: a
 * runaway macro or a compromised staff account cannot issue thousands of
 * moderation actions per minute. It is deliberately separate from automod,
 * which inspects message content and never looks at command frequency.
 *
 * Two buckets are tracked per user per guild:
 *   - commands: every command invocation
 *   - actions:  commands that change state (kick, ban, mute, purge, ...)
 *
 * The limiter is in-memory by design: only one bot instance runs per token
 * (see ecosystem.config.js), and a restart clearing buckets is acceptable.
 */

const { RateLimitError } = require('../utils/errors');
const { logger } = require('../utils/logger');

const log = logger.child('ratelimit');

const buckets = new Map(); // key -> number[] (timestamps)

/** Default limits; overridden from the environment at startup. */
let settings = {
  enabled: true,
  windowMs: 10000,
  maxCommands: 6,
  maxModActions: 3,
};

/** Apply environment-driven settings. */
function configure(config) {
  if (!config || !config.rateLimit) return;
  settings = {
    enabled: config.rateLimit.enabled !== false,
    windowMs: config.rateLimit.windowMs,
    maxCommands: config.rateLimit.maxCommands,
    maxModActions: config.rateLimit.maxModActions,
  };
  log.debug('Rate limits configured', { enabled: settings.enabled, windowMs: settings.windowMs });
}

/** Remove timestamps outside the window. */
function prune(entries, now) {
  const cutoff = now - settings.windowMs;
  let index = 0;
  while (index < entries.length && entries[index] < cutoff) index += 1;
  if (index > 0) entries.splice(0, index);
  return entries;
}

/**
 * Consume one unit from a bucket.
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {'command'|'action'} kind
 * @throws {RateLimitError} when the bucket is exhausted
 */
function consume(guildId, userId, kind) {
  if (!settings.enabled) return;

  const limit = kind === 'action' ? settings.maxModActions : settings.maxCommands;
  const key = `${guildId}:${userId}:${kind}`;
  const now = Date.now();

  const entries = prune(buckets.get(key) || [], now);
  buckets.set(key, entries);

  if (entries.length >= limit) {
    const retryAfterMs = Math.max(250, settings.windowMs - (now - entries[0]));
    const seconds = Math.ceil(retryAfterMs / 1000);
    throw new RateLimitError(
      `You are issuing commands too quickly. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
      { retryAfterMs },
    );
  }

  entries.push(now);

  // Opportunistic cleanup of idle buckets.
  if (buckets.size > 10000) {
    const cutoff = now - settings.windowMs * 4;
    for (const [bucketKey, timestamps] of buckets.entries()) {
      const last = timestamps[timestamps.length - 1] || 0;
      if (last < cutoff) buckets.delete(bucketKey);
    }
  }
}

/** Current usage snapshot, used in diagnostics. */
function snapshot(guildId, userId) {
  const now = Date.now();
  return {
    command: prune(buckets.get(`${guildId}:${userId}:command`) || [], now).length,
    action: prune(buckets.get(`${guildId}:${userId}:action`) || [], now).length,
    limits: { ...settings },
  };
}

/** Drop every bucket for a guild or user (used in tests and on config change). */
function reset(guildId, userId) {
  if (!guildId) {
    buckets.clear();
    return;
  }
  for (const key of [...buckets.keys()]) {
    if (key.startsWith(`${guildId}:`) && (!userId || key.startsWith(`${guildId}:${userId}:`))) {
      buckets.delete(key);
    }
  }
}

module.exports = { configure, consume, snapshot, reset, settings: () => ({ ...settings }) };
