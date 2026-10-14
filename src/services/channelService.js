'use strict';

/**
 * Channel-level moderation: purge, slowmode, lockdown and unlock, forced
 * nicknames, and nickname locking.
 *
 * These actions all record a case for accountability, and lockdown state is
 * remembered so the unlock path can restore every channel that was changed.
 */

const { PermissionFlagsBits, ChannelType } = require('discord.js');

const { ValidationError, ConfigError } = require('../utils/errors');
const { logger } = require('../utils/logger');
const { sanitizeReason, cleanText } = require('../utils/sanitize');
const { repo } = require('../db');
const moderationService = require('./moderationService');
const hierarchyService = require('./hierarchyService');

const log = logger.child('channels');
const { createKeyedQueue } = require('../utils/keyedQueue');
const channelQueue = createKeyedQueue();

/** Discord's bulk delete window: messages older than 14 days cannot be bulk deleted. */
const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Maximum messages a single purge invocation may remove. */
const PURGE_CHUNK_SIZE = 100;

/**
 * Purge messages from a channel.
 *
 * @param {object} ctx command context
 * @param {import('discord.js').TextChannel} channel
 * @param {object} options
 * @param {number} options.amount           how many candidate messages to scan
 * @param {string} [options.userId]         only messages from this user
 * @param {string} [options.match]          only messages containing this text
 * @param {boolean} [options.botsOnly]      only messages from bots
 * @param {boolean} [options.humansOnly]    only messages from humans
 * @returns {Promise<{deleted: number, scanned: number, skipped: number}>}
 */
async function purge(ctx, channel, options = {}) {
  hierarchyService.assertBotPermissions(ctx.guild, ['ManageMessages', 'ReadMessageHistory']);

  if (!channel.isTextBased || !channel.isTextBased()) {
    throw new ValidationError('Messages can only be purged from text channels.', { code: 'NOT_TEXT_CHANNEL' });
  }

  const amount = Math.max(1, Math.min(options.amount || 50, ctx.limits ? ctx.limits.maxPurgeCount : 1000));
  const collected = [];
  let scanned = 0;
  let lastId = null;

  // Read in pages until enough matching messages are found or history ends.
  while (collected.length < amount && scanned < amount * 5) {
    const batch = await channel.messages.fetch({ limit: Math.min(100, amount * 2), before: lastId || undefined }).catch(() => null);
    if (!batch || batch.size === 0) break;

    lastId = batch.last().id;
    scanned += batch.size;

    for (const message of batch.values()) {
      if (collected.length >= amount) break;
      if (options.userId && message.author.id !== options.userId) continue;
      if (options.botsOnly && !message.author.bot) continue;
      if (options.humansOnly && message.author.bot) continue;
      if (options.match) {
        const needle = options.match.toLowerCase();
        if (!message.content || !message.content.toLowerCase().includes(needle)) continue;
      }
      collected.push(message);
    }

    if (batch.size < 100) break;
  }

  if (collected.length === 0) {
    return { deleted: 0, scanned, skipped: 0 };
  }

  const cutoff = Date.now() - BULK_DELETE_MAX_AGE_MS;
  const recent = collected.filter((message) => message.createdTimestamp > cutoff);
  const old = collected.filter((message) => message.createdTimestamp <= cutoff);

  let deleted = 0;

  // Bulk delete works in chunks of 100.
  for (let index = 0; index < recent.length; index += PURGE_CHUNK_SIZE) {
    const chunk = recent.slice(index, index + PURGE_CHUNK_SIZE);
    const result = await channel.bulkDelete(chunk, true).catch(() => null);
    deleted += result ? result.size : 0;
  }

  // Messages older than 14 days must be removed individually.
  for (const message of old.slice(0, 50)) {
    const removed = await message.delete().then(() => true).catch(() => false);
    if (removed) deleted += 1;
  }

  const filters = [];
  if (options.userId) filters.push(`author <@${options.userId}>`);
  if (options.match) filters.push(`content contains "${cleanText(options.match, 60)}"`);
  if (options.botsOnly) filters.push('bots only');
  if (options.humansOnly) filters.push('humans only');

  await moderationService.applyAction({
    guild: ctx.guild,
    config: ctx.config,
    moderator: ctx.moderator,
    target: options.userId ? { id: options.userId, tag: options.userId } : null,
    action: 'purge',
    reason: options.reason || 'Bulk message removal',
    channelId: channel.id,
    perform: null,
    dm: false,
    dmOnPunishment: false,
    description: `${deleted} message${deleted === 1 ? '' : 's'} removed from <#${channel.id}>.`,
    extraFields: [
      { name: 'Channel', value: `<#${channel.id}>`, inline: true },
      { name: 'Removed', value: String(deleted), inline: true },
      ...(filters.length ? [{ name: 'Filters', value: filters.join(', '), inline: false }] : []),
      { name: 'Scanned', value: String(scanned), inline: true },
    ],
    metadata: {
      channelId: channel.id,
      deleted,
      scanned,
      filters: { userId: options.userId || null, match: options.match || null, botsOnly: Boolean(options.botsOnly) },
    },
  });

  return { deleted, scanned, skipped: collected.length - deleted };
}

/**
 * Set or clear channel slowmode.
 * @param {object} ctx
 * @param {import('discord.js').GuildChannel} channel
 * @param {number} seconds 0 clears slowmode
 * @param {string} [reason]
 */
async function slowmode(ctx, channel, seconds, reason) {
  hierarchyService.assertBotPermissions(ctx.guild, ['ManageChannels']);

  if (!channel.isTextBased || !channel.isTextBased()) {
    throw new ValidationError('Slowmode can only be configured on text channels.', { code: 'NOT_TEXT_CHANNEL' });
  }
  const value = Math.max(0, Math.min(Math.floor(seconds), 21600));

  await channel.setRateLimitPerUser(value, sanitizeReason(reason, { maxLength: 200, fallback: 'Slowmode updated' }));

  return moderationService.applyAction({
    guild: ctx.guild,
    config: ctx.config,
    moderator: ctx.moderator,
    target: null,
    action: 'slowmode',
    reason: reason || (value === 0 ? 'Slowmode disabled' : `Slowmode set to ${value} seconds`),
    channelId: channel.id,
    perform: null,
    dm: false,
    description: value === 0 ? 'Slowmode disabled.' : `Slowmode set to ${value} seconds.`,
    extraFields: [{ name: 'Channel', value: `<#${channel.id}>`, inline: true }],
    metadata: { channelId: channel.id, seconds: value },
  });
}

/**
 * Lock a single channel by denying SendMessages for the given roles.
 *
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildChannel} channel
 * @param {{reason?: string, roleIds?: string[], moderatorId?: string, recordCase?: boolean}} options
 * @returns {Promise<{locked: boolean, already: boolean, roleIds: string[]}>}
 */
function lockChannel(guild, channel, options = {}) {
  return channelQueue(`${guild.id}:${channel.id}`, async () => {
    if (!channel.permissionOverwrites || !channel.isTextBased?.() || channel.isThread?.()) {
      return { locked: false, already: false, roleIds: [] };
    }
    const roleIds = options.roleIds?.length ? options.roleIds : [guild.roles.everyone.id];
    const previous = {};
    for (const id of roleIds) {
      const overwrite = channel.permissionOverwrites.cache.get(id);
      if (overwrite?.deny.has(PermissionFlagsBits.SendMessages)) continue;
      previous[id] = overwrite?.allow.has(PermissionFlagsBits.SendMessages) ? true : null;
    }
    if (!Object.keys(previous).length) return { locked: false, already: true, roleIds };
    // Persist original overrides BEFORE editing Discord, including explicit allows.
    await repo('guilds').mutateMisc(guild.id, (misc) => {
      const locks = { ...(misc.channelLocks || {}) };
      locks[channel.id] = { ...previous, ...(locks[channel.id] || {}) };
      return { ...misc, channelLocks: locks };
    });
    for (const id of Object.keys(previous)) {
      await channel.permissionOverwrites.edit(id, { SendMessages: false }, {
        reason: sanitizeReason(options.reason, { maxLength: 200, fallback: 'Channel locked' }),
      });
    }
    return { locked: true, already: false, roleIds };
  });
}

/** Restore original overrides. Unknown legacy locks fall back to inheritance. */
function unlockChannel(guild, channel, options = {}) {
  return channelQueue(`${guild.id}:${channel.id}`, async () => {
    if (!channel.permissionOverwrites || !channel.isTextBased?.() || channel.isThread?.()) {
      return { unlocked: false, roleIds: [] };
    }
    const config = await repo('guilds').getConfig(guild.id, { force: true });
    const previous = config.misc?.channelLocks?.[channel.id];
    if (!previous && !options.allowLegacy) return { unlocked: false, roleIds: [] };
    const roleIds = options.roleIds?.length ? options.roleIds
      : previous ? Object.keys(previous) : config.lockdown?.roleIds?.length ? config.lockdown.roleIds : [guild.roles.everyone.id];
    let changed = false;
    for (const id of roleIds) {
      // If this lock has a snapshot, leave pre-existing denials alone.
      if (previous && !Object.prototype.hasOwnProperty.call(previous, id)) continue;
      const overwrite = channel.permissionOverwrites.cache.get(id);
      if (!overwrite?.deny.has(PermissionFlagsBits.SendMessages)) continue;
      await channel.permissionOverwrites.edit(id, { SendMessages: previous?.[id] ?? null }, {
        reason: sanitizeReason(options.reason, { maxLength: 200, fallback: 'Channel unlocked' }),
      });
      changed = true;
    }
    if (previous) await repo('guilds').mutateMisc(guild.id, (misc) => {
      const locks = { ...(misc.channelLocks || {}) };
      const remaining = { ...(locks[channel.id] || {}) };
      for (const id of roleIds) delete remaining[id];
      if (Object.keys(remaining).length) locks[channel.id] = remaining;
      else delete locks[channel.id];
      return { ...misc, channelLocks: locks };
    });
    return { unlocked: changed, roleIds };
  });
}

/**
 * Lock a channel or the whole server.
 *
 * @param {object} ctx command context
 * @param {import('discord.js').GuildChannel|null} channel null means server-wide
 * @returns {Promise<object>} moderation result
 */
async function lockdown(ctx, channel) {
  const config = ctx.config;
  const isServerWide = !channel;

  const targetChannels = isServerWide
    ? [...ctx.guild.channels.cache.values()]
      .filter((candidate) => candidate.isTextBased() && !candidate.isThread?.() && candidate.type !== ChannelType.GuildVoice)
      .slice(0, 200)
    : [channel];

  const roleIds = (config.lockdown && Array.isArray(config.lockdown.roleIds) && config.lockdown.roleIds.length > 0)
    ? config.lockdown.roleIds
    : [ctx.guild.roles.everyone.id];

  const lockedIds = [];
  const failedIds = [];
  for (const target of targetChannels) {
    const result = await lockChannel(ctx.guild, target, {
      reason: 'Lockdown applied',
      roleIds,
    }).catch((error) => {
      failedIds.push(target.id);
      log.warn('Lockdown channel failed', { channelId: target.id, code: error.code });
      return null;
    });
    if (result && result.locked) lockedIds.push(target.id);
  }

  if (!isServerWide && failedIds.length) throw new ValidationError('Could not fully lock this channel. Check Manage Roles and channel overrides; any partial changes can be restored with unlock.');

  const autoUnlockMinutes = config.lockdown && Number.isFinite(config.lockdown.autoUnlockMinutes)
    ? config.lockdown.autoUnlockMinutes
    : 0;

  const result = await moderationService.applyAction({
    guild: ctx.guild,
    config,
    moderator: ctx.moderator,
    target: null,
    action: isServerWide ? 'server_lockdown' : 'lockdown',
    reason: ctx.rawReason || 'Channel lockdown',
    channelId: isServerWide ? null : channel.id,
    perform: null,
    dm: false,
    description: isServerWide
      ? `${lockedIds.length} channels locked; ${failedIds.length} failed. Already-locked channels were left unchanged.`
      : (lockedIds.length ? `<#${channel.id}> locked.` : `<#${channel.id}> was already locked or is not lockable.`),
    extraFields: [
      { name: 'Channels', value: isServerWide ? String(lockedIds.length) : `<#${channel.id}>`, inline: true },
      { name: 'Denied Roles', value: roleIds.map((roleId) => `<@&${roleId}>`).join(', ').slice(0, 1024), inline: false },
      ...(autoUnlockMinutes ? [{ name: 'Automatic Unlock', value: `${autoUnlockMinutes} minutes`, inline: true }] : []),
    ],
    metadata: {
      serverWide: isServerWide,
      channelIds: lockedIds,
      roleIds,
      autoUnlockMinutes,
    },
  });

  if (autoUnlockMinutes > 0 && lockedIds.length > 0) {
    await repo('tasks').create(ctx.guild.id, {
      type: isServerWide ? 'unlock_server' : 'unlock',
      targetId: isServerWide ? null : channel.id,
      runAt: Date.now() + autoUnlockMinutes * 60 * 1000,
      payload: { moderatorId: ctx.moderator?.id || null, channelIds: lockedIds, roleIds, reason: 'Lockdown expired' },
      caseNumber: result.caseNumber,
    }).catch((error) => log.debug('Auto unlock task failed to queue', { code: error && error.code }));
  }

  return result;
}

/**
 * Unlock a channel or the whole server.
 * @param {object} ctx
 * @param {import('discord.js').GuildChannel|null} channel null means server-wide
 * @param {{system?: boolean, channelIds?: string[]}} [options]
 */
async function unlock(ctx, channel, options = {}) {
  const config = ctx.config;
  const isServerWide = !channel;

  // Saved snapshots, not today's defaults, determine which roles to restore.
  const roleIds = options.roleIds?.length ? options.roleIds : undefined;

  const targets = options.channelIds
    ? (await Promise.all(options.channelIds.map((id) => ctx.guild.channels.fetch(id).catch((error) => { if (error.code === 10003) return null; throw error; })))).filter(Boolean)
    : (isServerWide
      ? [...ctx.guild.channels.cache.values()].filter((candidate) => candidate.isTextBased() && !candidate.isThread?.())
      : [channel]);

  let unlockedCount = 0;
  let failedCount = 0;
  for (const target of targets.slice(0, 200)) {
    const result = await unlockChannel(ctx.guild, target, { roleIds, allowLegacy: Boolean(channel) && !options.system, reason: 'Lockdown lifted' }).catch((error) => {
      failedCount += 1;
      log.warn('Channel unlock failed', { channelId: target.id, code: error.code });
      return null;
    });
    if (result && result.unlocked) unlockedCount += 1;
  }

  if (failedCount && (options.system || !isServerWide)) throw new ValidationError('Some channels could not be unlocked. Check Manage Roles and channel overrides, then retry.');

  const result = await moderationService.applyAction({
    guild: ctx.guild,
    config,
    moderator: options.system ? null : ctx.moderator,
    target: null,
    action: isServerWide ? 'server_unlock' : 'unlock',
    reason: options.system ? 'Lockdown expired' : (ctx.rawReason || 'Lockdown lifted'),
    channelId: isServerWide ? null : channel.id,
    perform: null,
    dm: false,
    description: isServerWide
      ? `${unlockedCount} channels unlocked; ${failedCount} failed.`
      : `<#${channel.id}> unlocked.`,
    extraFields: [{ name: 'Channels Changed', value: String(unlockedCount), inline: true }],
    logEventKey: options.system ? 'punishment_expired' : 'mod_action',
    metadata: { serverWide: isServerWide, unlocked: unlockedCount },
  });

  if (!options.system && failedCount === 0) {
    await repo('tasks').cancel(ctx.guild.id, {
      type: isServerWide ? 'unlock_server' : 'unlock',
      targetId: isServerWide ? null : channel.id,
    }).catch(() => 0);
  }

  return result;
}

/**
 * Change or reset a member nickname.
 * @param {object} ctx
 * @param {import('discord.js').GuildMember} target
 * @param {string|null} nickname null resets to the username
 * @param {string} [reason]
 */
async function forceNickname(ctx, target, nickname, reason) {
  hierarchyService.assertBotPermissions(ctx.guild, ['ManageNicknames']);
  hierarchyService.assertCanActOn(ctx.moderator, target);

  const previous = target.nickname;
  const value = nickname === null || nickname === '' ? null : cleanText(nickname, 32);

  return moderationService.applyAction({
    guild: ctx.guild,
    config: ctx.config,
    moderator: ctx.moderator,
    target,
    action: 'forcenick',
    reason: reason || (value ? `Nickname set to ${value}` : 'Nickname reset'),
    guardTarget: true,
    dm: false,
    extraFields: [
      { name: 'Previous', value: previous || '(none)', inline: true },
      { name: 'New', value: value || '(reset)', inline: true },
    ],
    perform: async () => {
      if (!target.manageable) throw Object.assign(new Error('Member not manageable'), { code: 50013 });
      await target.setNickname(value, sanitizeReason(reason, { maxLength: 200, fallback: 'Nickname updated' }));
    },
    metadata: { previous, next: value },
  });
}

/**
 * Lock or unlock a member nickname. While locked, any manual nickname change is
 * reverted by the member update handler.
 *
 * @param {object} ctx
 * @param {import('discord.js').GuildMember} target
 * @param {string|null} nickname enforced nickname, or null to remove the lock
 * @param {string} [reason]
 */
async function toggleNicknameLock(ctx, target, nickname, reason) {
  hierarchyService.assertBotPermissions(ctx.guild, ['ManageNicknames']);
  hierarchyService.assertCanActOn(ctx.moderator, target);
  const removing = nickname === null || nickname === undefined || nickname === '';
  const saved = await repo('guilds').mutateMisc(ctx.guild.id, (misc) => {
    const locks = { ...(misc.nickLocks || {}) };
    if (removing) delete locks[target.id];
    else locks[target.id] = cleanText(nickname, 32);
    return { ...misc, nickLocks: locks };
  });
  const misc = saved.misc;
  const locks = misc.nickLocks;

  return moderationService.applyAction({
    guild: ctx.guild,
    config: { ...ctx.config, misc },
    moderator: ctx.moderator,
    target,
    action: 'nicklock',
    reason: reason || (removing ? 'Nickname lock removed' : 'Nickname locked'),
    perform: null,
    dm: false,
    description: removing
      ? 'Nickname lock removed. The member may change their nickname again.'
      : `Nickname locked to "${locks[target.id]}". Changes are reverted automatically.`,
    extraFields: [{ name: 'Locked Nickname', value: removing ? '(none)' : locks[target.id], inline: true }],
    metadata: { removing, nickname: removing ? null : locks[target.id], totalLocks: Object.keys(saved.misc?.nickLocks || {}).length },
  });
}

module.exports = {
  purge,
  slowmode,
  lockChannel,
  unlockChannel,
  lockdown,
  unlock,
  forceNickname,
  toggleNicknameLock,
  BULK_DELETE_MAX_AGE_MS,
};
