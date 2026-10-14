'use strict';

/**
 * Member lifecycle: joins (with account age warning),
 * leaves (with kick attribution), nickname changes, and role changes.
 *
 * Nickname locks configured through the nicklock command are enforced here by
 * reverting any change to a locked nickname.
 */

const { AuditLogEvent } = require('discord.js');

const { cleanText } = require('../utils/sanitize');
const { humanizeAge } = require('../utils/duration');
const { repo } = require('../db');
const loggingService = require('../services/loggingService');
const { logger } = require('../utils/logger');

const log = logger.child('events');

/** Accounts younger than this are flagged in the join log. */
const NEW_ACCOUNT_DAYS = 7;

function register(client, deps) {
  client.on('guildMemberAdd', (member) => {
    void handleJoin(client, deps, member);
  });

  client.on('guildMemberRemove', (member) => {
    void handleLeave(client, member);
  });

  client.on('guildMemberUpdate', (before, after) => {
    void handleUpdate(client, before, after);
  });
}

async function handleJoin(client, deps, member) {
  try {
    const guild = member.guild;

    const accountAgeMs = Date.now() - member.user.createdTimestamp;
    const isNewAccount = accountAgeMs < NEW_ACCOUNT_DAYS * 24 * 60 * 60 * 1000;

    await loggingService.emit(guild, 'member_join', {
      title: 'Member Joined',
      description: `${member.user.tag} joined the server.`,
      fields: [
        { name: 'Account Created', value: humanizeAge(member.user.createdTimestamp), inline: true },
        { name: 'Member Count', value: String(guild.memberCount), inline: true },
        { name: 'Account Age Warning', value: isNewAccount ? `Account is newer than ${NEW_ACCOUNT_DAYS} days. Review before granting trust.` : 'None', inline: true },
        { name: 'Member', value: `<@${member.id}> (${member.id})`, inline: false },
      ],
      thumbnail: member.user.displayAvatarURL({ size: 128 }),
      footer: guild.name,
    });
  } catch (error) {
    log.debug('Member join handling failed', { code: error && error.code });
  }
}

async function handleLeave(client, member) {
  try {
    const guild = member.guild;
    const attribution = await loggingService.findAuditEntry(guild, AuditLogEvent.MemberKick, {
      targetId: member.id,
      windowMs: 15000,
    });

    const roles = member.roles && member.roles.cache
      ? member.roles.cache.filter((role) => role.id !== guild.id).map((role) => role.name).slice(0, 15)
      : [];

    await loggingService.emit(guild, 'member_leave', {
      title: attribution ? 'Member Kicked' : 'Member Left',
      description: attribution
        ? `${member.user.tag} was removed by ${attribution.executorTag || attribution.executorId}.`
        : `${member.user.tag} left the server.`,
      fields: [
        { name: 'Joined', value: member.joinedTimestamp ? humanizeAge(member.joinedTimestamp) : 'Unknown', inline: true },
        { name: 'Member Count', value: String(guild.memberCount), inline: true },
        { name: 'Roles', value: roles.join(', ').slice(0, 1024) || 'None', inline: false },
        ...(attribution && attribution.reason ? [{ name: 'Reason', value: cleanText(attribution.reason, 300), inline: false }] : []),
      ],
      thumbnail: member.user.displayAvatarURL({ size: 128 }),
      footer: guild.name,
    });
  } catch (error) {
    log.debug('Member leave handling failed', { code: error && error.code });
  }
}

async function handleUpdate(client, before, after) {
  try {
    const guild = after.guild;

    // 1. Nickname handling: revert locked nicknames, then log the change.
    if (before.nickname !== after.nickname) {
      await enforceNicknameLock(guild, before, after);

      const previous = before.nickname || before.user.username;
      const next = after.nickname || after.user.username;
      const attribution = await loggingService.findAuditEntry(guild, AuditLogEvent.MemberUpdate, {
        targetId: after.id,
        windowMs: 8000,
      });

      await loggingService.emit(guild, 'member_nickname_update', {
        title: 'Nickname Changed',
        description: `${after.user.tag}`,
        fields: [
          { name: 'Before', value: cleanText(previous, 200), inline: true },
          { name: 'After', value: cleanText(next, 200), inline: true },
          { name: 'Changed By', value: attribution ? `${attribution.executorTag || attribution.executorId}` : 'The member or an unknown actor', inline: false },
        ],
        thumbnail: after.user.displayAvatarURL({ size: 128 }),
        footer: guild.name,
      });
    }

    // 2. Role changes.
    const added = after.roles.cache.filter((role) => !before.roles.cache.has(role.id));
    const removed = before.roles.cache.filter((role) => !after.roles.cache.has(role.id));

    if (added.size > 0 || removed.size > 0) {
      const attribution = await loggingService.findAuditEntry(guild, AuditLogEvent.MemberRoleUpdate, {
        targetId: after.id,
        windowMs: 8000,
      });

      await loggingService.emit(guild, 'member_roles_update', {
        title: 'Member Roles Updated',
        description: `${after.user.tag} (${after.id})`,
        fields: [
          { name: 'Added', value: added.map((role) => role.name).join(', ').slice(0, 1024) || 'None', inline: false },
          { name: 'Removed', value: removed.map((role) => role.name).join(', ').slice(0, 1024) || 'None', inline: false },
          { name: 'Changed By', value: attribution ? `${attribution.executorTag || attribution.executorId}` : 'Unknown', inline: false },
        ],
        thumbnail: after.user.displayAvatarURL({ size: 128 }),
        footer: guild.name,
      });
    }
  } catch (error) {
    log.debug('Member update handling failed', { code: error && error.code });
  }
}

/**
 * Revert a nickname change when the member is locked or a global lock applies.
 * Fails silently when the bot cannot manage the member.
 */
async function enforceNicknameLock(guild, before, after) {
  try {
    const config = await repo('guilds').getConfig(guild.id);
    const misc = config.misc || {};
    const locks = misc.nickLocks || {};

    const lockedNickname = locks[after.id];
    const globalLock = misc.nickLockAll === true && Array.isArray(misc.nickLockRoleIds)
      && misc.nickLockRoleIds.some((roleId) => after.roles.cache.has(roleId));

    if (!lockedNickname && !globalLock) return;

    const target = lockedNickname || before.nickname || null;
    if ((after.nickname || null) === target) return;

    const me = guild.members.me;
    if (!me || !after.manageable) return;

    await after.setNickname(target, 'Nickname lock enforced').catch(() => null);
  } catch (error) {
    log.debug('Nickname lock enforcement failed', { code: error && error.code });
  }
}

module.exports = { register };
