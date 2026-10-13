'use strict';

/**
 * Punishment operations.
 *
 * Each function performs the Discord API call, records the case, writes the
 * punishment state row, schedules any expiry task, notifies the member, and
 * logs the action - all through the shared moderation pipeline. Commands stay
 * thin: they resolve arguments and call one of these functions.
 *
 * Timeout handling uses Discord's native timeout (ModerateMembers) rather than
 * a "muted" role, which is the modern, permission-safe approach. A mute role
 * is still supported for servers that rely on one and is applied in addition
 * when enabled in configuration.
 */

const { PermissionFlagsBits } = require('discord.js');

const { DISCORD_TIMEOUT_MAX_MS, TASK_TYPES, MESSAGES } = require('../config/constants');
const { ValidationError, ConfigError, DatabaseError } = require('../utils/errors');
const { formatDuration } = require('../utils/duration');
const { logger } = require('../utils/logger');
const { repo } = require('../db');

const moderationService = require('./moderationService');
const hierarchyService = require('./hierarchyService');

const log = logger.child('punishments');

/** Clamp a timeout duration to what Discord accepts. */
function clampTimeout(ms, limitMs) {
  const max = Math.min(DISCORD_TIMEOUT_MAX_MS, limitMs || DISCORD_TIMEOUT_MAX_MS);
  if (ms > max) {
    throw new ValidationError(
      `The maximum mute length is ${formatDuration(max)}. Use a shorter duration or apply a ban instead.`,
      { code: 'DURATION_TOO_LONG' },
    );
  }
  return ms;
}

/** Build the interaction-free reason string Discord stores in its audit log. */
function auditReason(ctx, reason, caseNumber) {
  const base = reason || 'No reason provided';
  const by = ctx.moderator && ctx.moderator.user ? ctx.moderator.user.tag : 'system';
  return `${base} | ${by} | case #${caseNumber || 'pending'}`.slice(0, 500);
}

/* ------------------------------------------------------------------ timeout */

/**
 * Apply a mute using Discord's native timeout.
 * @param {object} ctx command context
 * @param {import('discord.js').GuildMember} target
 * @param {{reason: string, durationMs: number, evidenceUrl?: string, temporary?: boolean}} options
 */
async function mute(ctx, target, options) {
  const durationMs = clampTimeout(options.durationMs, ctx.config.limits ? ctx.config.limits.maxTimeoutMs : undefined);
  hierarchyService.assertBotPermissions(ctx.guild, ['ModerateMembers']);

  const useMuteRole = Boolean(ctx.config.muteRoleEnabled && ctx.config.mutedRoleId);
  let muteRole = null;
  if (useMuteRole) {
    muteRole = await ctx.guild.roles.fetch(ctx.config.mutedRoleId).catch(() => null);
    if (!muteRole) {
      throw new ConfigError('The configured mute role no longer exists. Run the setup wizard to pick a new one.', { code: 'MUTE_ROLE_MISSING' });
    }
    hierarchyService.assertCanManageRole(ctx.guild, muteRole);
  }

  return moderationService.applyAction({
    guild: ctx.guild,
    config: ctx.config,
    moderator: ctx.moderator,
    target,
    action: options.temporary ? 'tempmute' : 'mute',
    reason: options.reason,
    evidenceUrl: options.evidenceUrl,
    durationMs,
    expiresAt: Date.now() + durationMs,
    guardTarget: true,
    dm: true,
    extraFields: [{ name: 'Method', value: 'Discord native timeout', inline: true }],
    perform: async () => {
      await target.timeout(durationMs, auditReason(ctx, options.reason, null));
      if (muteRole) await target.roles.add(muteRole, auditReason(ctx, options.reason, null));
    },
    punishment: { type: 'mute', expiresAt: Date.now() + durationMs },
    task: options.temporary ? {
      type: TASK_TYPES.UNMUTE,
      targetId: target.id,
      runAt: Date.now() + durationMs,
      payload: { moderatorId: ctx.moderator ? ctx.moderator.id : 'system', reason: 'Temporary mute expired', timed: true },
    } : null,
    metadata: { duration: durationMs, method: 'timeout', muteRole: muteRole ? muteRole.id : null },
    footer: ctx.guild.name,
  });
}

/**
 * Remove a mute.
 * @param {object} ctx
 * @param {import('discord.js').GuildMember} target
 * @param {{reason: string, evidenceUrl?: string, system?: boolean, caseNumber?: number}} options
 */
async function unmute(ctx, target, options = {}) {
  hierarchyService.assertBotPermissions(ctx.guild, ['ModerateMembers']);

  const result = await moderationService.applyAction({
    guild: ctx.guild,
    config: ctx.config,
    moderator: ctx.moderator,
    target,
    action: 'unmute',
    reason: options.reason,
    evidenceUrl: options.evidenceUrl,
    guardTarget: false,
    dm: true,
    description: options.system ? 'The temporary mute expired and was lifted automatically.' : undefined,
    perform: async () => {
      if (target.isCommunicationDisabled && target.isCommunicationDisabled()) {
        await target.timeout(null, auditReason(ctx, options.reason, options.caseNumber));
      }
      if (ctx.config.muteRoleEnabled && ctx.config.mutedRoleId && target.roles.cache.has(ctx.config.mutedRoleId)) {
        await target.roles.remove(ctx.config.mutedRoleId, auditReason(ctx, options.reason, options.caseNumber)).catch(() => null);
      }
    },
    logEventKey: options.system ? 'punishment_expired' : 'mod_action',
    metadata: { system: Boolean(options.system) },
  });

  await repo('punishments').clear(ctx.guild.id, {
    userId: target.id,
    type: 'mute',
    clearedBy: ctx.moderator ? ctx.moderator.id : null,
    reason: options.reason,
  });
  await repo('tasks').cancel(ctx.guild.id, { type: TASK_TYPES.UNMUTE, targetId: target.id });

  return result;
}

/* ---------------------------------------------------------------------- kick */

/** Kick a member. */
async function kick(ctx, target, options) {
  hierarchyService.assertBotPermissions(ctx.guild, ['KickMembers']);

  return moderationService.applyAction({
    guild: ctx.guild,
    config: ctx.config,
    moderator: ctx.moderator,
    target,
    action: 'kick',
    reason: options.reason,
    evidenceUrl: options.evidenceUrl,
    guardTarget: true,
    dm: true,
    perform: async () => {
      if (!target.kickable) throw Object.assign(new Error('Member is not kickable'), { code: 50013 });
      await target.kick(auditReason(ctx, options.reason, null));
    },
  });
}

/* ----------------------------------------------------------------------- ban */

/**
 * Ban a member or user.
 * @param {object} options
 * @param {number} [options.durationMs] when set the ban is temporary
 * @param {number} [options.deleteMessageSeconds] purge recent messages
 * @param {boolean} [options.softban] ban then immediately unban
 */
async function ban(ctx, target, options) {
  hierarchyService.assertBotPermissions(ctx.guild, ['BanMembers']);

  const durationMs = options.durationMs || null;
  const expiresAt = durationMs ? Date.now() + durationMs : null;
  const isMember = Boolean(target.roles);
  const userId = target.id;

  if (isMember && target.bannable === false) {
    throw new ValidationError('That member cannot be banned by the bot. Check the role hierarchy.', { code: 'NOT_BANNABLE' });
  }

  const action = options.softban ? 'softban' : (durationMs ? 'tempban' : 'ban');

  const result = await moderationService.applyAction({
    guild: ctx.guild,
    config: ctx.config,
    moderator: ctx.moderator,
    target,
    action,
    reason: options.reason,
    evidenceUrl: options.evidenceUrl,
    durationMs,
    expiresAt,
    guardTarget: true,
    dm: !options.softban,
    description: options.softban
      ? 'The member was banned and immediately unbanned to remove their recent messages.'
      : undefined,
    perform: async () => {
      await ctx.guild.members.ban(userId, {
        reason: auditReason(ctx, options.reason, null),
        deleteMessageSeconds: options.deleteMessageSeconds || (options.softban ? 604800 : undefined),
      });
      if (options.softban) {
        await ctx.guild.members.unban(userId, 'Softban: messages purged');
      }
    },
    punishment: options.softban ? null : { type: 'ban', expiresAt },
    task: !options.softban && expiresAt ? {
      type: TASK_TYPES.UNBAN,
      targetId: userId,
      runAt: expiresAt,
      payload: { moderatorId: ctx.moderator ? ctx.moderator.id : 'system', reason: 'Temporary ban expired' },
    } : null,
    metadata: {
      duration: durationMs,
      deleteMessageSeconds: options.deleteMessageSeconds || (options.softban ? 604800 : 0),
      softban: Boolean(options.softban),
    },
  });

  return result;
}

/**
 * Remove a ban.
 * @param {object} ctx
 * @param {import('discord.js').User} user resolved user object (not a member)
 * @param {{reason: string, caseNumber?: number, system?: boolean}} options
 */
async function unban(ctx, user, options = {}) {
  hierarchyService.assertBotPermissions(ctx.guild, ['BanMembers']);

  const existing = await ctx.guild.bans.fetch(user.id).catch(() => null);
  if (!existing) {
    throw new ValidationError('That user is not currently banned.', { code: 'NOT_BANNED' });
  }

  const result = await moderationService.applyAction({
    guild: ctx.guild,
    config: ctx.config,
    moderator: ctx.moderator,
    target: user,
    action: 'unban',
    reason: options.reason,
    guardTarget: false,
    dm: true,
    description: options.system ? 'The temporary ban expired and was lifted automatically.' : undefined,
    perform: async () => {
      await ctx.guild.members.unban(user.id, auditReason(ctx, options.reason, options.caseNumber));
    },
    logEventKey: options.system ? 'punishment_expired' : 'mod_action',
    metadata: { system: Boolean(options.system) },
  });

  await repo('punishments').clear(ctx.guild.id, {
    userId: user.id,
    type: 'ban',
    clearedBy: ctx.moderator ? ctx.moderator.id : null,
    reason: options.reason,
  });
  await repo('tasks').cancel(ctx.guild.id, { type: TASK_TYPES.UNBAN, targetId: user.id });

  return result;
}

/* -------------------------------------------------------------------- warn */

/**
 * Warn a member. The warning row is created by the pipeline and linked to the
 * case, so delwarn can deactivate it later.
 */
async function warn(ctx, target, options) {
  const warningExpiryDays = Number.isFinite(options.warningExpiresDays) ? options.warningExpiresDays : 0;
  const expiresAt = warningExpiryDays > 0 ? Date.now() + warningExpiryDays * 24 * 60 * 60 * 1000 : null;

  const result = await moderationService.applyAction({
    guild: ctx.guild,
    config: ctx.config,
    moderator: ctx.moderator,
    target,
    action: 'warn',
    reason: options.reason,
    evidenceUrl: options.evidenceUrl,
    guardTarget: false,
    dm: true,
    warning: { expiresAt },
    metadata: { warningExpiresAt: expiresAt },
    extraFields: expiresAt ? [{ name: 'Warning Expires', value: 'Configured expiry applied', inline: true }] : undefined,
  });

  const counts = await repo('warnings').count(ctx.guild.id, target.id, true).catch(() => ({ active: 0, total: 0 }));
  result.warningCounts = counts;
  return result;
}

/** Remove one warning by id, optionally logging a case for the removal. */
async function removeWarning(ctx, warningId, reason) {
  const warning = await repo('warnings').remove(ctx.guild.id, warningId, ctx.moderator.id);
  if (!warning) {
    throw new ValidationError('No warning with that id was found in this server.', { code: 'WARNING_NOT_FOUND' });
  }

  const record = await moderationService.applyAction({
    guild: ctx.guild,
    config: ctx.config,
    moderator: ctx.moderator,
    target: { id: warning.userId, tag: warning.userId },
    action: 'delwarn',
    reason: reason || `Removed warning ${warningId}`,
    perform: null,
    logEvent: true,
    description: 'The warning was removed from the member history.',
    metadata: { warningId, previousReason: warning.reason, caseNumber: warning.caseNumber },
  });

  return { warning, record };
}

/** Clear every active warning for a member. */
async function clearWarnings(ctx, target, reason) {
  const cleared = await repo('warnings').clearAll(ctx.guild.id, target.id, ctx.moderator.id);

  const record = await moderationService.applyAction({
    guild: ctx.guild,
    config: ctx.config,
    moderator: ctx.moderator,
    target,
    action: 'clearwarnings',
    reason: reason || 'All warnings cleared',
    perform: null,
    description: `${cleared} warning${cleared === 1 ? '' : 's'} cleared.`,
    metadata: { cleared },
  });

  return { cleared, record };
}

/* -------------------------------------------------------------------- notes */

/** Add a private moderator note. No DM is sent and the user is never notified. */
async function addNote(ctx, targetUserId, content) {
  const note = await repo('notes').create(ctx.guild.id, {
    userId: targetUserId,
    authorId: ctx.moderator.id,
    content,
  });

  if (!note || !note.id) {
    // The gateway acknowledged the write but returned no record; treat this as
    // a storage failure rather than dereferencing a missing value.
    throw new DatabaseError('The note could not be stored', { code: 'NOTE_WRITE_FAILED' });
  }

  const result = await moderationService.applyAction({
    guild: ctx.guild,
    config: ctx.config,
    moderator: ctx.moderator,
    target: { id: targetUserId, tag: targetUserId },
    action: 'note',
    reason: content,
    perform: null,
    dm: false,
    description: 'Private staff note. The member is not notified.',
    metadata: { noteId: note.id },
    extraFields: [{ name: 'Note ID', value: String(note.id), inline: true }],
  });

  return { note, result };
}

/* --------------------------------------------------------- temporary roles */

/** Add a role for a limited time. */
async function tempRole(ctx, target, role, durationMs, options = {}) {
  hierarchyService.assertCanManageRole(ctx.guild, role);

  if (target.roles.cache.has(role.id)) {
    throw new ValidationError('That member already has this role.', { code: 'ROLE_ALREADY_PRESENT' });
  }

  const runAt = Date.now() + durationMs;

  return moderationService.applyAction({
    guild: ctx.guild,
    config: ctx.config,
    moderator: ctx.moderator,
    target,
    action: 'temprole',
    reason: options.reason,
    durationMs,
    expiresAt: runAt,
    guardTarget: true,
    dm: false,
    extraFields: [{ name: 'Role', value: `${role.name} (${role.id})`, inline: true }],
    perform: async () => {
      await target.roles.add(role, auditReason(ctx, options.reason, null));
    },
    punishment: { type: 'role', roleId: role.id, expiresAt: runAt },
    task: {
      type: TASK_TYPES.REMOVE_ROLE,
      targetId: target.id,
      runAt,
      payload: { roleId: role.id, moderatorId: ctx.moderator ? ctx.moderator.id : 'system', reason: 'Temporary role expired', roleName: role.name },
    },
    metadata: { roleId: role.id, roleName: role.name, duration: durationMs },
  });
}

/** Add a role permanently. */
async function addRole(ctx, target, role, options = {}) {
  hierarchyService.assertCanManageRole(ctx.guild, role);
  if (target.roles.cache.has(role.id)) {
    throw new ValidationError('That member already has this role.', { code: 'ROLE_ALREADY_PRESENT' });
  }

  return moderationService.applyAction({
    guild: ctx.guild,
    config: ctx.config,
    moderator: ctx.moderator,
    target,
    action: 'addrole',
    reason: options.reason,
    guardTarget: true,
    dm: false,
    extraFields: [{ name: 'Role', value: `${role.name} (${role.id})`, inline: true }],
    perform: async () => {
      await target.roles.add(role, auditReason(ctx, options.reason, null));
    },
    metadata: { roleId: role.id, roleName: role.name },
  });
}

/** Remove a role. */
async function removeRole(ctx, target, role, options = {}) {
  hierarchyService.assertCanManageRole(ctx.guild, role);
  if (!target.roles.cache.has(role.id)) {
    throw new ValidationError('That member does not have this role.', { code: 'ROLE_ABSENT' });
  }

  const result = await moderationService.applyAction({
    guild: ctx.guild,
    config: ctx.config,
    moderator: ctx.moderator,
    target,
    action: 'removerole',
    reason: options.reason,
    guardTarget: true,
    dm: false,
    extraFields: [{ name: 'Role', value: `${role.name} (${role.id})`, inline: true }],
    perform: async () => {
      await target.roles.remove(role, auditReason(ctx, options.reason, null));
    },
    metadata: { roleId: role.id, roleName: role.name },
  });

  await repo('punishments').clear(ctx.guild.id, {
    userId: target.id,
    type: 'role',
    clearedBy: ctx.moderator.id,
    reason: options.reason,
  });
  await repo('tasks').cancel(ctx.guild.id, { type: TASK_TYPES.REMOVE_ROLE, targetId: target.id });

  return result;
}

/**
 * Remove an expired temporary role. Used by the scheduler; there is no
 * moderator member involved, so the case is recorded as a system action.
 */
async function expireTempRole(guild, target, role, meta = {}) {
  await target.roles.remove(role, 'Temporary role expired').catch((error) => {
    if (error && error.code !== 10007) throw error;
  });

  await repo('punishments').clear(guild.id, {
    userId: target.id,
    type: 'role',
    clearedBy: null,
    reason: 'Temporary role expired',
  });

  return moderationService.recordSystemAction({
    guild,
    action: 'expiry',
    target,
    moderatorId: 'system',
    reason: meta.reason || 'Temporary role expired',
    title: `Case - Temporary role removed: ${role.name}`,
    fields: [
      { name: 'Role', value: `${role.name} (${role.id})`, inline: true },
      { name: 'Origin Case', value: meta.caseNumber ? `#${meta.caseNumber}` : 'Unknown', inline: true },
    ],
    logEventKey: 'punishment_expired',
    metadata: { roleId: role.id, originCase: meta.caseNumber || null },
  });
}

/** True when the guild configuration can actually mute members. */
function assertMuteAvailable(ctx) {
  if (!ctx.guild.members.me || !ctx.guild.members.me.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    throw new ConfigError(MESSAGES.genericError, { code: 'MUTE_UNAVAILABLE' });
  }
}

module.exports = {
  mute,
  unmute,
  kick,
  ban,
  unban,
  warn,
  removeWarning,
  clearWarnings,
  addNote,
  addRole,
  removeRole,
  tempRole,
  expireTempRole,
  clampTimeout,
  assertMuteAvailable,
};
