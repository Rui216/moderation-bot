/**
 * Automod, logging, and escalation settings.
 *
 * Both settings documents are stored as JSON in their own tables so they can
 * be updated independently of the main guild row. Updates are deep merges: the
 * bot sends only the keys it changed, and this module validates them.
 */

import { first, run, cacheGet, cachePut, cacheDelete, insertReturningId } from '../core/db.js';
import {
  requireSnowflake,
  bool,
  int,
  text,
  parseJsonColumn,
  toJsonColumn,
  requireObject,
  nowMs,
  oneOf,
  snowflakeArray,
  stringArray,
} from '../core/validate.js';

/** Rules the escalation ladder and per-rule configuration accept. */
export const AUTOMOD_RULES = ['invites', 'links', 'words', 'caps', 'mentions', 'emoji'];

/** Punishments accepted for automod rules and escalation steps. */
export const AUTOMOD_PUNISHMENTS = ['none', 'delete', 'warn', 'mute', 'tempmute', 'kick', 'ban', 'tempban'];

/** Recursive merge where the patch wins; arrays and primitives replace. */
function deepMerge(base, patch, depth = 0) {
  if (depth > 6) return patch;
  if (Array.isArray(patch)) return patch;
  if (patch === null || patch === undefined) return base;
  if (typeof patch !== 'object') return patch;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    return { ...patch };
  }
  const output = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    output[key] = deepMerge(base[key], value, depth + 1);
  }
  return output;
}

/**
 * Normalize and validate an automod configuration document.
 * Unknown keys are dropped so the stored document stays predictable.
 */
export function normalizeAutomod(input) {
  const source = parseJsonColumn(input, {});
  const rules = parseJsonColumn(source.rules, {});
  const normalizedRules = {};

  for (const rule of AUTOMOD_RULES) {
    const entry = rules[rule] && typeof rules[rule] === 'object' ? rules[rule] : {};
    normalizedRules[rule] = {
      enabled: bool(entry.enabled, false),
      punishment: AUTOMOD_PUNISHMENTS.includes(entry.punishment) ? entry.punishment : 'delete',
      strikeWeight: int(entry.strikeWeight, { min: 0, max: 10, fallback: 1 }),
      ...(rule === 'invites' ? { allowList: snowflakeArray(entry.allowList, 'invites.allowList', 100) } : {}),
      ...(rule === 'links' ? {
        allowList: stringArray(entry.allowList, { field: 'links.allowList' }).map((value) => value.toLowerCase()),
        blockList: stringArray(entry.blockList, { field: 'links.blockList' }).map((value) => value.toLowerCase()),
      } : {}),
      ...(rule === 'words' ? {
        words: stringArray(entry.words, { field: 'words.words', max: 500, maxLength: 64 }).map((value) => value.toLowerCase()),
        allowList: stringArray(entry.allowList, { field: 'words.allowList' }).map((value) => value.toLowerCase()),
        matchWholeWord: bool(entry.matchWholeWord, true),
      } : {}),
      ...(rule === 'caps' ? {
        minLength: int(entry.minLength, { min: 5, max: 200, fallback: 12 }),
        thresholdPercent: int(entry.thresholdPercent, { min: 30, max: 100, fallback: 70 }),
      } : {}),
      ...(rule === 'mentions' ? {
        maxMentions: int(entry.maxMentions, { min: 1, max: 50, fallback: 6 }),
        includeRoleMentions: bool(entry.includeRoleMentions, false),
      } : {}),
      ...(rule === 'emoji' ? {
        maxEmoji: int(entry.maxEmoji, { min: 1, max: 100, fallback: 8 }),
        thresholdPercent: int(entry.thresholdPercent, { min: 10, max: 100, fallback: 40 }),
      } : {}),
    };
  }

  const escalation = parseJsonColumn(source.escalation, {});
  const steps = Array.isArray(escalation.steps) ? escalation.steps : [];
  const normalizedSteps = steps
    .slice(0, 12)
    .map((step) => {
      const entry = step && typeof step === 'object' ? step : {};
      const action = AUTOMOD_PUNISHMENTS.includes(entry.action) ? entry.action : null;
      const strikes = int(entry.strikes, { min: 1, max: 100, fallback: null });
      if (!action || !strikes) return null;
      return {
        strikes,
        action,
        duration: entry.duration ? text(entry.duration, 16) : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.strikes - b.strikes);

  const raid = parseJsonColumn(source.raid, {});
  const exemptions = parseJsonColumn(source.exemptions, {});

  return {
    enabled: bool(source.enabled, true),
    exemptions: {
      roleIds: snowflakeArray(exemptions.roleIds, 'exemptions.roleIds'),
      channelIds: snowflakeArray(exemptions.channelIds, 'exemptions.channelIds'),
      ignoreBots: bool(exemptions.ignoreBots, true),
      ignoreStaff: bool(exemptions.ignoreStaff, true),
    },
    rules: normalizedRules,
    escalation: {
      enabled: bool(escalation.enabled, true),
      windowHours: int(escalation.windowHours, { min: 1, max: 720, fallback: 24 }),
      steps: normalizedSteps,
    },
    raid: {
      enabled: bool(raid.enabled, true),
      threshold: int(raid.threshold, { min: 2, max: 200, fallback: 8 }),
      windowSeconds: int(raid.windowSeconds, { min: 5, max: 600, fallback: 30 }),
      minAccountAgeDays: int(raid.minAccountAgeDays, { min: 0, max: 365, fallback: 7 }),
      action: ['alert', 'lockdown'].includes(raid.action) ? raid.action : 'alert',
      autoUnlockMinutes: int(raid.autoUnlockMinutes, { min: 0, max: 10080, fallback: 30 }),
      lockChannelIds: snowflakeArray(raid.lockChannelIds, 'raid.lockChannelIds'),
      lockRoleIds: snowflakeArray(raid.lockRoleIds, 'raid.lockRoleIds'),
    },
  };
}

/** Read automod settings, creating defaults on first access. */
export async function getAutomodSettings(env, guildId) {
  requireSnowflake(guildId, 'guildId');
  const cacheKey = `automod:${guildId}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return cached;

  const row = await first(env.DB, 'SELECT settings FROM automod_settings WHERE guild_id = ?1', [guildId]);
  const settings = row ? normalizeAutomod(parseJsonColumn(row.settings, {})) : normalizeAutomod({});
  await cachePut(env, cacheKey, settings, int(env.CONFIG_CACHE_SECONDS, { min: 0, max: 3600, fallback: 60 }));
  return settings;
}

/** Merge a partial automod update. */
export async function updateAutomodSettings(env, guildId, patchInput) {
  requireSnowflake(guildId, 'guildId');
  requireObject(patchInput, 'patch');

  const current = await getAutomodSettings(env, guildId);
  const merged = normalizeAutomod(deepMerge(current, patchInput));
  const now = nowMs();

  const existing = await first(env.DB, 'SELECT guild_id FROM automod_settings WHERE guild_id = ?1', [guildId]);
  if (existing) {
    await run(env.DB, 'UPDATE automod_settings SET settings = ?1, updated_at = ?2 WHERE guild_id = ?3', [toJsonColumn(merged), now, guildId]);
  } else {
    await insertReturningId(
      env.DB,
      'INSERT INTO automod_settings (guild_id, enabled, settings, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)',
      [guildId, merged.enabled ? 1 : 0, toJsonColumn(merged), now],
    );
  }

  // Keep the scalar mirror column in sync for cheap filtering.
  await run(env.DB, 'UPDATE automod_settings SET enabled = ?1 WHERE guild_id = ?2', [merged.enabled ? 1 : 0, guildId]);

  await cacheDelete(env, `automod:${guildId}`);
  return merged;
}

/** Normalize a logging configuration document. */
export function normalizeLogging(input) {
  const source = parseJsonColumn(input, {});
  const channels = parseJsonColumn(source.channels, {});
  const events = parseJsonColumn(source.events, {});

  const normalizedChannels = {};
  for (const [slot, value] of Object.entries(channels)) {
    if (!/^[a-zA-Z]{2,32}$/.test(slot)) continue;
    if (value === null || value === undefined || value === '') {
      normalizedChannels[slot] = null;
      continue;
    }
    try {
      normalizedChannels[slot] = requireSnowflake(value, `channels.${slot}`);
    } catch {
      normalizedChannels[slot] = null;
    }
  }

  const normalizedEvents = {};
  for (const [event, value] of Object.entries(events)) {
    if (!/^[a-z_]{3,48}$/.test(event)) continue;
    const entry = value && typeof value === 'object' ? value : {};
    let channelId = null;
    if (entry.channelId) {
      try {
        channelId = requireSnowflake(entry.channelId, `events.${event}.channelId`);
      } catch {
        channelId = null;
      }
    }
    normalizedEvents[event] = { enabled: bool(entry.enabled, false), channelId };
  }

  return {
    channels: normalizedChannels,
    events: normalizedEvents,
    ignoreChannelIds: snowflakeArray(source.ignoreChannelIds, 'ignoreChannelIds'),
    ignoreBotMessages: bool(source.ignoreBotMessages, true),
  };
}

/** Read logging settings, creating defaults on first access. */
export async function getLoggingSettings(env, guildId) {
  requireSnowflake(guildId, 'guildId');
  const cacheKey = `logging:${guildId}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return cached;

  const row = await first(env.DB, 'SELECT channels, events, ignore_channel_ids, ignore_bot_messages FROM logging_settings WHERE guild_id = ?1', [guildId]);
  const settings = row
    ? normalizeLogging({
      channels: parseJsonColumn(row.channels, {}),
      events: parseJsonColumn(row.events, {}),
      ignoreChannelIds: parseJsonColumn(row.ignore_channel_ids, []),
      ignoreBotMessages: Boolean(row.ignore_bot_messages),
    })
    : normalizeLogging({});

  await cachePut(env, cacheKey, settings, int(env.CONFIG_CACHE_SECONDS, { min: 0, max: 3600, fallback: 60 }));
  return settings;
}

/** Merge a partial logging update. */
export async function updateLoggingSettings(env, guildId, patchInput) {
  requireSnowflake(guildId, 'guildId');
  requireObject(patchInput, 'patch');

  const current = await getLoggingSettings(env, guildId);
  const merged = normalizeLogging(deepMerge(current, patchInput));
  const now = nowMs();

  const existing = await first(env.DB, 'SELECT guild_id FROM logging_settings WHERE guild_id = ?1', [guildId]);
  if (existing) {
    await run(
      env.DB,
      `UPDATE logging_settings SET channels = ?1, events = ?2, ignore_channel_ids = ?3, ignore_bot_messages = ?4, updated_at = ?5
       WHERE guild_id = ?6`,
      [toJsonColumn(merged.channels), toJsonColumn(merged.events), toJsonColumn(merged.ignoreChannelIds),
        merged.ignoreBotMessages ? 1 : 0, now, guildId],
    );
  } else {
    await insertReturningId(
      env.DB,
      `INSERT INTO logging_settings (guild_id, channels, events, ignore_channel_ids, ignore_bot_messages, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
      [guildId, toJsonColumn(merged.channels), toJsonColumn(merged.events), toJsonColumn(merged.ignoreChannelIds),
        merged.ignoreBotMessages ? 1 : 0, now],
    );
  }

  await cacheDelete(env, `logging:${guildId}`);
  return merged;
}
