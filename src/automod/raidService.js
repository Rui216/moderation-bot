'use strict';

/**
 * Raid protection: mass-join detection.
 *
 * A sliding window of recent joins is kept per guild in memory. When the number
 * of joins inside the configured window reaches the threshold, the guild
 * either receives an alert or is locked down automatically, depending on the
 * raid configuration. Account age is recorded with each join so young accounts
 * can be prioritised in the alert.
 *
 * The window is intentionally in memory: a raid is a live event, and losing the
 * window on restart simply restarts detection. Nothing in the enforcement path
 * depends on the in-memory state - the lockdown itself is applied through the
 * normal services and can be recorded and reversed.
 */

const { logger } = require('../utils/logger');
const { humanizeAge } = require('../utils/duration');
const { repo } = require('../db');
const loggingService = require('../services/loggingService');
const moderationService = require('../services/moderationService');

const log = logger.child('raid');

/** guildId -> array of { userId, timestamp, accountCreatedAt } */
const joinWindows = new Map();

/** guildId -> timestamp of the last raid response, to avoid repeated triggers. */
const lastTriggered = new Map();

/** Minimum gap between automatic raid responses for the same guild. */
const TRIGGER_COOLDOWN_MS = 10 * 60 * 1000;

/** Drop entries older than the window. */
function prune(entries, windowSeconds) {
  const cutoff = Date.now() - windowSeconds * 1000;
  let index = 0;
  while (index < entries.length && entries[index].timestamp < cutoff) index += 1;
  if (index > 0) entries.splice(0, index);
  return entries;
}

/**
 * Record a join and evaluate raid conditions.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {object} context
 * @param {object} context.config guild configuration
 * @param {object} context.automod automod configuration (contains raid settings)
 * @returns {Promise<{triggered: boolean, reason?: string, joins?: number}>}
 */
async function recordJoin(member, context) {
  const guild = member.guild;
  const raid = (context.automod && context.automod.raid) || {};

  if (raid.enabled === false) return { triggered: false, reason: 'disabled' };

  const windowSeconds = Number.isFinite(raid.windowSeconds) ? raid.windowSeconds : 30;
  const threshold = Number.isFinite(raid.threshold) ? raid.threshold : 8;

  const entries = prune(joinWindows.get(guild.id) || [], windowSeconds);
  entries.push({
    userId: member.id,
    timestamp: Date.now(),
    accountCreatedAt: member.user && member.user.createdTimestamp ? member.user.createdTimestamp : null,
  });
  joinWindows.set(guild.id, entries);

  if (entries.length < threshold) return { triggered: false, joins: entries.length };

  const lastTrigger = lastTriggered.get(guild.id) || 0;
  if (Date.now() - lastTrigger < TRIGGER_COOLDOWN_MS) {
    return { triggered: false, reason: 'cooldown', joins: entries.length };
  }

  lastTriggered.set(guild.id, Date.now());

  const minAccountAgeDays = Number.isFinite(raid.minAccountAgeDays) ? raid.minAccountAgeDays : 7;
  const youngAccounts = entries.filter((entry) => {
    if (!entry.accountCreatedAt) return false;
    const ageDays = (Date.now() - entry.accountCreatedAt) / (24 * 60 * 60 * 1000);
    return ageDays < minAccountAgeDays;
  });

  const summaryFields = [
    { name: 'Joins In Window', value: `${entries.length} in ${windowSeconds} seconds`, inline: true },
    { name: 'Threshold', value: String(threshold), inline: true },
    { name: 'Accounts Younger Than', value: `${minAccountAgeDays} days: ${youngAccounts.length}`, inline: true },
    {
      name: 'Newest Accounts',
      value: entries.slice(-8).map((entry) => {
        const age = entry.accountCreatedAt ? humanizeAge(entry.accountCreatedAt) : 'unknown age';
        return `<@${entry.userId}> created ${age}`;
      }).join('\n') || 'None',
      inline: false,
    },
  ];

  await loggingService.emit(guild, 'member_join', {
    title: 'Raid Protection Triggered',
    description: `Join rate reached the configured threshold. Automatic action: ${raid.action || 'alert'}.`,
    fields: summaryFields,
  });

  if (raid.action === 'lockdown') {
    await applyRaidLockdown(guild, context, raid, entries.length);
  }

  try {
    await moderationService.recordSystemAction({
      guild,
      action: 'raid',
      target: null,
      moderatorId: 'system',
      reason: `Join rate threshold reached: ${entries.length} joins in ${windowSeconds} seconds`,
      title: 'Raid Protection Triggered',
      fields: summaryFields,
      metadata: {
        joins: entries.length,
        windowSeconds,
        threshold,
        action: raid.action || 'alert',
        youngAccounts: youngAccounts.length,
      },
      logEventKey: 'automod_trigger',
    });
  } catch (error) {
    log.debug('Raid case could not be recorded', { code: error && error.code });
  }

  return { triggered: true, joins: entries.length };
}

/**
 * Lock the configured channels when raid protection fires, and schedule an
 * automatic unlock when autoUnlockMinutes is set.
 */
async function applyRaidLockdown(guild, context, raid, joinCount) {
  const channelIds = Array.isArray(raid.lockChannelIds) && raid.lockChannelIds.length > 0
    ? raid.lockChannelIds
    : [...guild.channels.cache.values()]
      .filter((channel) => channel.isTextBased && channel.isTextBased() && !channel.isThread?.())
      .map((channel) => channel.id);

  let locked = 0;
  const lockedIds = [];
  for (const channelId of channelIds.slice(0, 200)) {
    const channel = guild.channels.cache.get(channelId);
    if (!channel) continue;

    const result = await guild.client.services.channelService.lockChannel(guild, channel, {
      reason: `Raid protection: ${joinCount} joins in ${raid.windowSeconds || 30} seconds`,
      roleIds: raid.lockRoleIds,
      moderatorId: 'system',
      recordCase: false,
    }).catch(() => null);

    if (result && result.locked) { locked += 1; lockedIds.push(channelId); }
  }

  if (locked === 0) return;

  const autoUnlockMinutes = Number.isFinite(raid.autoUnlockMinutes) && raid.autoUnlockMinutes > 0
    ? raid.autoUnlockMinutes
    : null;

  if (autoUnlockMinutes) {
    await repo('tasks').create(guild.id, {
      type: 'unlock_server',
      targetId: null,
      runAt: Date.now() + autoUnlockMinutes * 60 * 1000,
      payload: { moderatorId: 'system', reason: 'Raid lockdown expired', channelIds: lockedIds, roleIds: raid.lockRoleIds || [guild.roles.everyone.id] },
    }).catch((error) => log.debug('Auto unlock task failed to queue', { code: error && error.code }));
  }

  await moderationService.recordSystemAction({
    guild,
    action: 'server_lockdown',
    target: null,
    moderatorId: 'system',
    reason: 'Automatic lockdown triggered by raid protection',
    title: 'Server Lockdown Applied',
    description: autoUnlockMinutes
      ? `Lockdown applied to ${locked} channels. Automatic unlock in ${autoUnlockMinutes} minutes.`
      : `Lockdown applied to ${locked} channels. Manual unlock required.`,
    fields: [{ name: 'Channels Locked', value: String(locked), inline: true }],
    metadata: { locked, channelIds: channelIds.slice(0, 200), autoUnlockMinutes },
  });
}

/** Clear the join window for a guild, e.g. after a manual lockdown. */
function resetWindow(guildId) {
  joinWindows.delete(guildId);
  lastTriggered.delete(guildId);
}

/** Current window size, for diagnostics. */
function windowSize(guildId) {
  return (joinWindows.get(guildId) || []).length;
}

module.exports = { recordJoin, resetWindow, windowSize, TRIGGER_COOLDOWN_MS };
