'use strict';

/**
 * Guild configuration repository.
 *
 * Reads merge what is stored in D1 on top of the code defaults, so a guild row
 * created by an older version of the bot still produces a complete, valid
 * configuration document. Writes send only the changed keys.
 *
 * A short-lived in-process cache keeps configuration reads off the network for
 * the hot path (every message that may trigger automod or logging).
 */

const { defaultGuildConfig, defaultAutomodConfig, defaultLoggingConfig } = require('../../config/defaults');
const { LOG_EVENTS, LOG_CHANNEL_SLOTS } = require('../../config/constants');
const { deepMerge, deepClone } = require('../../utils/objects');
const { logger } = require('../../utils/logger');

const log = logger.child('config');

/** Milliseconds a configuration document stays cached in memory. */
const CACHE_TTL_MS = 60 * 1000;

const cache = new Map(); // key -> { value, expiresAt }

let gateway = null;

/** Bound by the data layer during initialisation. */
function attach(instance) {
  gateway = instance;
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value, ttl = CACHE_TTL_MS) {
  cache.set(key, { value, expiresAt: Date.now() + ttl });
  // Keep the cache bounded even on very large deployments.
  if (cache.size > 5000) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

/** Drop cached entries for a guild (or everything when no id is given). */
function invalidate(guildId) {
  if (!guildId) {
    cache.clear();
    return;
  }
  for (const key of [...cache.keys()]) {
    if (key.includes(guildId)) cache.delete(key);
  }
}

/**
 * Complete the configuration document: stored values win, defaults fill gaps,
 * and unknown log event keys from an older schema are dropped.
 */
function normalizeConfig(raw, guildId) {
  const defaults = defaultGuildConfig();
  const merged = deepMerge(defaults, raw || {});
  merged.guildId = guildId;
  if (raw && raw.guildName) merged.guildName = raw.guildName;

  merged.lockdown = deepMerge(defaults.lockdown, merged.lockdown || {});
  merged.misc = deepMerge(defaults.misc, merged.misc || {});
  return merged;
}

/**
 * Fetch a guild configuration, creating an unconfigured default document when
 * the guild has no row yet.
 * @param {string} guildId
 * @param {{force?: boolean}} options
 */
async function getConfig(guildId, options = {}) {
  const cacheKey = `config:${guildId}`;
  if (!options.force) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
  }

  let raw = null;
  try {
    raw = await gateway.getGuildConfig(guildId);
  } catch (error) {
    if (error.code === 'NOT_FOUND' || error.status === 404) {
      raw = null;
    } else {
      throw error;
    }
  }

  const config = normalizeConfig(raw, guildId);
  config.configured = Boolean(raw && raw.configuredAt);
  cacheSet(cacheKey, config);
  return config;
}

/**
 * Apply a partial configuration update and refresh the cache.
 * @param {string} guildId
 * @param {object} patch
 */
async function updateConfig(guildId, patch) {
  const saved = await gateway.updateGuildConfig(guildId, patch || {});
  invalidate(guildId);
  const config = normalizeConfig(saved, guildId);
  config.configured = Boolean(saved && saved.configuredAt);
  cacheSet(`config:${guildId}`, config);
  log.debug('Guild configuration updated', { guildId, keys: Object.keys(patch || {}).length });
  return config;
}

/**
 * Complete a logging document: every known event key is present with an
 * explicit enabled flag and channel routing, and every known channel slot is
 * defined (null when unassigned).
 */
function normalizeLogging(raw, guildId) {
  const defaults = defaultLoggingConfig();
  const merged = deepMerge(defaults, raw || {});
  merged.guildId = guildId;

  const events = {};
  for (const [key, meta] of Object.entries(LOG_EVENTS)) {
    const stored = (merged.events && merged.events[key]) || {};
    events[key] = {
      enabled: stored.enabled === undefined ? meta.defaultEnabled : Boolean(stored.enabled),
      channelId: stored.channelId || null,
    };
  }
  merged.events = events;

  const channels = {};
  for (const slot of Object.keys(LOG_CHANNEL_SLOTS)) {
    channels[slot] = (merged.channels && merged.channels[slot]) || null;
  }
  merged.channels = channels;
  merged.ignoreChannelIds = Array.isArray(merged.ignoreChannelIds) ? merged.ignoreChannelIds : [];
  merged.ignoreBotMessages = merged.ignoreBotMessages !== false;

  return merged;
}

/**
 * Fetch automod settings merged with defaults.
 * @param {string} guildId
 * @param {{force?: boolean}} options
 */
async function getAutomod(guildId, options = {}) {
  const cacheKey = `automod:${guildId}`;
  if (!options.force) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
  }

  let raw = null;
  try {
    raw = await gateway.getAutomodConfig(guildId);
  } catch (error) {
    if (error.status !== 404) throw error;
    raw = null;
  }

  const merged = deepMerge(defaultAutomodConfig(), raw || {});
  cacheSet(cacheKey, merged);
  return merged;
}

/** Merge a partial automod update. */
async function updateAutomod(guildId, patch) {
  const saved = await gateway.updateAutomodConfig(guildId, patch || {});
  invalidate(guildId);
  const merged = deepMerge(defaultAutomodConfig(), saved || {});
  cacheSet(`automod:${guildId}`, merged);
  return merged;
}

/**
 * Fetch logging settings merged with defaults.
 * @param {string} guildId
 * @param {{force?: boolean}} options
 */
async function getLogging(guildId, options = {}) {
  const cacheKey = `logging:${guildId}`;
  if (!options.force) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
  }

  let raw = null;
  try {
    raw = await gateway.getLoggingConfig(guildId);
  } catch (error) {
    if (error.status !== 404) throw error;
    raw = null;
  }

  const merged = deepMerge(defaultLoggingConfig(), raw || {});
  cacheSet(cacheKey, merged);
  return merged;
}

/** Merge a partial logging update. */
async function updateLogging(guildId, patch) {
  const saved = await gateway.updateLoggingConfig(guildId, patch || {});
  invalidate(guildId);
  const merged = normalizeLogging(saved, guildId);
  cacheSet(`logging:${guildId}`, merged);
  return merged;
}

/** Aggregate counters for the config command. */
async function getStats(guildId) {
  const response = await gateway.getGuildStats(guildId);
  return response.stats || { cases: 0, activeWarnings: 0, notes: 0, pendingTasks: 0 };
}

/** Remove every stored value for a guild (used when the bot is removed). */
async function purge(guildId) {
  await gateway.purgeGuild(guildId);
  invalidate(guildId);
}

/**
 * Snapshot of the effective configuration for the current process, used by the
 * self test and by diagnostics. Never printed to Discord.
 */
function cacheStats() {
  return { entries: cache.size };
}

module.exports = {
  attach,
  getConfig,
  updateConfig,
  getAutomod,
  updateAutomod,
  getLogging,
  updateLogging,
  getStats,
  purge,
  invalidate,
  normalizeConfig,
  normalizeLogging,
  cacheStats,
  deepClone,
};
