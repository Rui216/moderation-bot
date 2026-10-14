'use strict';

/**
 * Read-only health check. Reports which command groups have the permissions
 * and setup they need, without changing anything in the server.
 */

const { PermissionFlagsBits } = require('discord.js');
const { COLORS } = require('../../config/constants');
const { baseEmbed } = require('../../utils/embeds');
const { getGateway } = require('../../db');
const ticketService = require('../../services/ticketService');
const { logger } = require('../../utils/logger');

const log = logger.child('command');

/** Each group lists the bot permissions its commands need. */
const GROUPS = [
  { name: 'Moderation (kick, ban, tempban, softban, unban, mute, tempmute)', needs: ['KickMembers', 'BanMembers', 'ModerateMembers'] },
  { name: 'Roles (addrole, removerole, temprole, forcenick, nicklock)', needs: ['ManageRoles', 'ManageNicknames'] },
  { name: 'Channels (purge, slowmode, lockdown, unlock)', needs: ['ManageChannels', 'ManageMessages'] },
  { name: 'Automod (delete messages, mute, strikes)', needs: ['ManageMessages', 'ModerateMembers'] },
  { name: 'Tickets (ticketpanel, ticketclose)', needs: ['ManageChannels', 'ManageMessages'] },
  { name: 'Logs and info (modlog, serverinfo, whois, stats)', needs: ['ViewAuditLog', 'EmbedLinks'] },
];

/** Discord permission names mapped to flags, for the names used above. */
function flagFor(name) {
  return PermissionFlagsBits[name];
}

module.exports = {
  name: 'doctor',
  aliases: ['check', 'diagnose'],
  description: 'Check the bot setup and report which command groups are ready.',
  usage: 'doctor',
  examples: ['doctor'],
  permission: 'admin',
  action: null,
  slashOptions: [],

  async execute(ctx) {
    const guild = ctx.guild;
    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    const lines = [];

    // Setup checks.
    let gatewayStatus = 'Reachable';
    try {
      await getGateway().health();
    } catch (error) {
      gatewayStatus = 'Not reachable';
      log.warn('Doctor gateway check failed', { code: error && error.code });
    }
    lines.push(`Storage gateway: ${gatewayStatus}`);
    lines.push(`Slash commands: ${ctx.appConfig.discord.enableSlashCommands ? 'Enabled' : 'Disabled'}`);
    lines.push(`Prefix commands in this server: ${ctx.config.prefixEnabled === false ? 'Off' : 'On'}`);

    const bot = me && me.roles.botRole;
    lines.push(`Bot role: ${bot ? 'Present' : 'Missing (re-invite the bot to create it)'}`);
    if (me) {
      const highest = me.roles.highest;
      lines.push(`Bot role position: ${highest ? highest.position : 'unknown'}`);
    }

    const settings = ticketService.readSettings(ctx.config.misc);
    lines.push(`Tickets: ${settings.categoryId && settings.supportRoleId ? 'Configured' : 'Not configured (run ticketsetup)'}`);
    lines.push(`Mute role: ${ctx.config.muteRoleEnabled && ctx.config.muteRoleId ? 'Configured' : 'Not set'}`);

    // Permission groups.
    const groupLines = GROUPS.map((group) => {
      if (!me) return `${group.name}: unknown (bot member not found)`;
      const missing = group.needs.filter((name) => {
        const flag = flagFor(name);
        return !flag || !me.permissions.has(flag);
      });
      return missing.length === 0
        ? `${group.name}: Ready`
        : `${group.name}: Missing ${missing.join(', ')}`;
    });

    const channelPerms = me && ctx.channel && typeof ctx.channel.permissionsFor === 'function'
      ? ctx.channel.permissionsFor(me)
      : null;

    const canSend = channelPerms ? channelPerms.has(PermissionFlagsBits.SendMessages) : false;

    await ctx.replyEmbed(baseEmbed({
      title: 'Bot Health Check',
      color: COLORS.info,
      description: 'Read-only check. Nothing in the server was changed.',
      fields: [
        { name: 'Setup', value: lines.join('\n'), inline: false },
        { name: 'Command groups', value: groupLines.join('\n'), inline: false },
        { name: 'This channel', value: canSend ? 'The bot can send messages here.' : 'The bot cannot send messages here.', inline: false },
      ],
      footer: guild.name,
    }));
  },
};
