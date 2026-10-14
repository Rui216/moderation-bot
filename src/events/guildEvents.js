'use strict';

/**
 * Guild lifecycle: when the bot joins a server it posts a short setup prompt,
 * and when it is removed the stored configuration and history are deleted so no
 * orphaned data is left in the database.
 */

const { COLORS } = require('../config/constants');
const { baseEmbed } = require('../utils/embeds');
const { logger } = require('../utils/logger');
const { repo } = require('../db');

const log = logger.child('events');

function register(client, deps) {
  client.on('guildCreate', (guild) => {
    void handleCreate(client, deps, guild);
  });

  client.on('guildDelete', (guild) => {
    void handleDelete(guild);
  });
}

async function handleCreate(client, deps, guild) {
  try {
    log.info('Added to a new guild', { guildId: guild.id });

    const prefix = deps.appConfig.discord.defaultPrefix;

    // Prefer the system channel, otherwise the first channel the bot can write in.
    const target = guild.systemChannel
      || guild.channels.cache.find((channel) => (
        channel.isTextBased()
        && channel.permissionsFor(guild.members.me)?.has('SendMessages')
      ));

    if (!target) return;

    const check = guild.members.me.permissions;
    const missing = [];
    if (!check.has('ModerateMembers')) missing.push('Timeout Members');
    if (!check.has('KickMembers')) missing.push('Kick Members');
    if (!check.has('BanMembers')) missing.push('Ban Members');
    if (!check.has('ManageMessages')) missing.push('Manage Messages');
    if (!check.has('ManageChannels')) missing.push('Manage Channels');
    if (!check.has('ManageRoles')) missing.push('Manage Roles');
    if (!check.has('ViewAuditLog')) missing.push('View Audit Log');

    await target.send({
      embeds: [baseEmbed({
        title: 'Moderation Bot Ready',
        color: COLORS.info,
        description: [
          'Thanks for adding the bot. A server administrator must run `/setup` before any other command works.',
          '',
          'The wizard walks through the command prefix, staff roles, log channels, automod, and lockdown defaults.',
          `Use \`${prefix}help\` to see the commands available to you.`,
        ].join('\n'),
        fields: missing.length > 0
          ? [{
            name: 'Permissions To Review',
            value: `${missing.join(', ')}\nGrant these in the server settings, or via the bot role, for full functionality.`,
            inline: false,
          }]
          : [],
        footer: guild.name,
      })],
    }).catch(() => null);
  } catch (error) {
    log.debug('Guild create handling failed', { code: error && error.code });
  }
}

async function handleDelete(guild) {
  try {
    await repo('guilds').purge(guild.id);
    log.info('Guild removed; stored configuration purged', { guildId: guild.id });
  } catch (error) {
    // A transient failure is not fatal: the periodic tasks will simply find no guild.
    log.warn('Guild purge failed', { guildId: guild.id, code: error && error.code });
  }
}

module.exports = { register };
