'use strict';

/**
 * Server structure logging: channels, roles, guild settings, and invites.
 *
 * Each event type has its own toggle, so a busy server can keep role change
 * logging while turning channel noise off.
 */

const { AuditLogEvent } = require('discord.js');

const loggingService = require('../services/loggingService');
const { cleanText } = require('../utils/sanitize');
const { logger } = require('../utils/logger');

const log = logger.child('events');

function register(client) {
  client.on('channelCreate', (channel) => void logChannelChange(channel.guild, 'channel_create', channel, 'Channel Created'));
  client.on('channelDelete', (channel) => void logChannelChange(channel.guild, 'channel_delete', channel, 'Channel Deleted'));
  client.on('channelUpdate', (before, after) => void logChannelUpdate(before, after));

  client.on('roleCreate', (role) => void logRoleChange(role.guild, 'role_create', role, 'Role Created'));
  client.on('roleDelete', (role) => void logRoleChange(role.guild, 'role_delete', role, 'Role Deleted'));
  client.on('roleUpdate', (before, after) => void logRoleUpdate(before, after));

  client.on('guildUpdate', (before, after) => void logGuildUpdate(before, after));

  client.on('inviteCreate', (invite) => void logInvite(invite, 'invite_create', 'Invite Created'));
  client.on('inviteDelete', (invite) => void logInvite(invite, 'invite_delete', 'Invite Deleted'));
}

async function logChannelChange(guild, eventKey, channel, title) {
  try {
    if (!guild) return;
    const attribution = await loggingService.findAuditEntry(guild, AuditLogEvent.ChannelCreate, { windowMs: 10000 });

    await loggingService.emit(guild, eventKey, {
      title,
      description: `${channel.name || 'unknown'} (${channel.type})`,
      fields: [
        { name: 'Channel', value: channel.id, inline: true },
        { name: 'Category', value: channel.parent ? channel.parent.name : 'None', inline: true },
        { name: 'Actor', value: attribution ? `${attribution.executorTag || attribution.executorId}` : 'Unknown', inline: true },
      ],
      footer: guild.name,
    });
  } catch (error) {
    log.debug('Channel change logging failed', { code: error && error.code });
  }
}

async function logChannelUpdate(before, after) {
  try {
    const guild = after.guild;
    if (!guild) return;

    const changes = [];
    if (before.name !== after.name) changes.push(`Name: ${before.name} -> ${after.name}`);
    if (before.topic !== after.topic) changes.push(`Topic changed`);
    if (before.rateLimitPerUser !== after.rateLimitPerUser) {
      changes.push(`Slowmode: ${before.rateLimitPerUser || 0}s -> ${after.rateLimitPerUser || 0}s`);
    }
    if (before.nsfw !== after.nsfw) changes.push(`NSFW: ${before.nsfw} -> ${after.nsfw}`);
    if (changes.length === 0) {
      // Permission overwrites changed without any of the tracked fields.
      changes.push('Permission overwrites or positioning updated');
    }

    const attribution = await loggingService.findAuditEntry(guild, AuditLogEvent.ChannelUpdate, {
      targetId: after.id,
      windowMs: 10000,
    });

    await loggingService.emit(guild, 'channel_update', {
      title: 'Channel Updated',
      description: `<#${after.id}>`,
      fields: [
        { name: 'Changes', value: changes.join('\n').slice(0, 1024), inline: false },
        { name: 'Actor', value: attribution ? `${attribution.executorTag || attribution.executorId}` : 'Unknown', inline: true },
      ],
      footer: guild.name,
    });
  } catch (error) {
    log.debug('Channel update logging failed', { code: error && error.code });
  }
}

async function logRoleChange(guild, eventKey, role, title) {
  try {
    if (!guild) return;
    const attribution = await loggingService.findAuditEntry(
      guild,
      eventKey === 'role_create' ? AuditLogEvent.RoleCreate : AuditLogEvent.RoleDelete,
      { windowMs: 10000 },
    );

    await loggingService.emit(guild, eventKey, {
      title,
      description: role.name,
      fields: [
        { name: 'Role', value: role.id, inline: true },
        { name: 'Color', value: role.hexColor, inline: true },
        { name: 'Actor', value: attribution ? `${attribution.executorTag || attribution.executorId}` : 'Unknown', inline: true },
      ],
      footer: guild.name,
    });
  } catch (error) {
    log.debug('Role change logging failed', { code: error && error.code });
  }
}

async function logRoleUpdate(before, after) {
  try {
    const guild = after.guild;
    if (!guild) return;

    const changes = [];
    if (before.name !== after.name) changes.push(`Name: ${before.name} -> ${after.name}`);
    if (before.hexColor !== after.hexColor) changes.push(`Color: ${before.hexColor} -> ${after.hexColor}`);
    if (before.hoist !== after.hoist) changes.push(`Displayed separately: ${before.hoist} -> ${after.hoist}`);
    if (before.mentionable !== after.mentionable) changes.push(`Mentionable: ${before.mentionable} -> ${after.mentionable}`);
    if (before.permissions.bitfield !== after.permissions.bitfield) changes.push('Permissions changed');
    if (changes.length === 0) return;

    const attribution = await loggingService.findAuditEntry(guild, AuditLogEvent.RoleUpdate, {
      targetId: after.id,
      windowMs: 10000,
    });

    await loggingService.emit(guild, 'role_update', {
      title: 'Role Updated',
      description: after.name,
      fields: [
        { name: 'Changes', value: changes.join('\n').slice(0, 1024), inline: false },
        { name: 'Actor', value: attribution ? `${attribution.executorTag || attribution.executorId}` : 'Unknown', inline: true },
      ],
      footer: guild.name,
    });
  } catch (error) {
    log.debug('Role update logging failed', { code: error && error.code });
  }
}

async function logGuildUpdate(before, after) {
  try {
    const changes = [];
    if (before.name !== after.name) changes.push(`Name: ${before.name} -> ${after.name}`);
    if (before.verificationLevel !== after.verificationLevel) {
      changes.push(`Verification level: ${before.verificationLevel} -> ${after.verificationLevel}`);
    }
    if (before.explicitContentFilter !== after.explicitContentFilter) {
      changes.push(`Explicit content filter: ${before.explicitContentFilter} -> ${after.explicitContentFilter}`);
    }
    if ((before.iconURL() || null) !== (after.iconURL() || null)) changes.push('Icon changed');
    if (changes.length === 0) return;

    await loggingService.emit(after, 'guild_update', {
      title: 'Server Settings Changed',
      description: changes.join('\n').slice(0, 1024),
      footer: after.name,
    });
  } catch (error) {
    log.debug('Guild update logging failed', { code: error && error.code });
  }
}

async function logInvite(invite, eventKey, title) {
  try {
    const guild = invite.guild;
    if (!guild || !guild.channels) return;

    await loggingService.emit(guild, eventKey, {
      title,
      description: `Code: ${cleanText(invite.code, 40)}`,
      fields: [
        { name: 'Channel', value: invite.channelId ? `<#${invite.channelId}>` : 'Unknown', inline: true },
        { name: 'Inviter', value: invite.inviterId ? `<@${invite.inviterId}>` : 'Unknown', inline: true },
        ...(invite.maxUses ? [{ name: 'Max Uses', value: String(invite.maxUses), inline: true }] : []),
      ],
      footer: guild.name,
    });
  } catch (error) {
    log.debug('Invite logging failed', { code: error && error.code });
  }
}

module.exports = { register };
