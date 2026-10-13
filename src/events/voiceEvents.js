'use strict';

/** Voice channel join, leave, and move logging. */

const { AuditLogEvent } = require('discord.js');

const loggingService = require('../services/loggingService');
const { logger } = require('../utils/logger');

const log = logger.child('events');

function register(client) {
  client.on('voiceStateUpdate', (before, after) => {
    void handle(client, before, after);
  });
}

async function handle(client, before, after) {
  try {
    const guild = after.guild || before.guild;
    if (!guild) return;

    const member = after.member || before.member;
    if (!member) return;
    if (member.user.bot) return;

    const beforeChannel = before.channel;
    const afterChannel = after.channel;

    // No change in channel membership.
    if (beforeChannel && afterChannel && beforeChannel.id === afterChannel.id) return;

    if (!beforeChannel && afterChannel) {
      await loggingService.emit(guild, 'voice_join', {
        title: 'Voice Channel Joined',
        description: `${member.user.tag} joined ${afterChannel.name}.`,
        fields: [
          { name: 'Channel', value: `<#${afterChannel.id}>`, inline: true },
          { name: 'Member', value: `<@${member.id}>`, inline: true },
        ],
        footer: guild.name,
      });
      return;
    }

    if (beforeChannel && !afterChannel) {
      await loggingService.emit(guild, 'voice_leave', {
        title: 'Voice Channel Left',
        description: `${member.user.tag} left ${beforeChannel.name}.`,
        fields: [
          { name: 'Channel', value: `<#${beforeChannel.id}>`, inline: true },
          { name: 'Member', value: `<@${member.id}>`, inline: true },
        ],
        footer: guild.name,
      });
      return;
    }

    if (beforeChannel && afterChannel && beforeChannel.id !== afterChannel.id) {
      const attribution = await loggingService.findAuditEntry(guild, AuditLogEvent.MemberMove, {
        targetId: member.id,
        windowMs: 8000,
      });

      await loggingService.emit(guild, 'voice_move', {
        title: 'Voice Channel Moved',
        description: `${member.user.tag} moved from ${beforeChannel.name} to ${afterChannel.name}.`,
        fields: [
          { name: 'From', value: `<#${beforeChannel.id}>`, inline: true },
          { name: 'To', value: `<#${afterChannel.id}>`, inline: true },
          { name: 'Moved By', value: attribution ? `${attribution.executorTag || attribution.executorId}` : 'The member or unknown', inline: true },
        ],
        footer: guild.name,
      });
    }
  } catch (error) {
    log.debug('Voice state logging failed', { code: error && error.code });
  }
}

module.exports = { register };
