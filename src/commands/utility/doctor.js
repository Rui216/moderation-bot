'use strict';

/**
 * Read-only health check. Reports which command groups have the permissions
 * and setup they need, without changing anything in the server.
 *
 * The checks themselves live in readinessService so the setup wizard summary
 * reports exactly the same results.
 */

const { PermissionFlagsBits } = require('discord.js');
const { COLORS } = require('../../config/constants');
const { baseEmbed } = require('../../utils/embeds');
const { getGateway } = require('../../db');
const ticketService = require('../../services/ticketService');
const readinessService = require('../../services/readinessService');
const { logger } = require('../../utils/logger');

const log = logger.child('command');

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

    let gatewayStatus = 'Reachable';
    try {
      await getGateway().health();
    } catch (error) {
      gatewayStatus = 'Not reachable';
      log.warn('Doctor gateway check failed', { code: error && error.code });
    }

    const checks = readinessService.buildChecks({
      guild,
      me,
      gatewayStatus,
      settings: {
        logChannels: ctx.config.logChannels || {},
        muteRoleEnabled: ctx.config.muteRoleEnabled,
        mutedRoleId: ctx.config.mutedRoleId,
        appealsEnabled: Boolean(ctx.config.misc && ctx.config.misc.appeals && ctx.config.misc.appeals.enabled),
        appealsChannelId: ctx.config.misc && ctx.config.misc.appeals ? ctx.config.misc.appeals.channelId : null,
      },
    });
    const counts = readinessService.summarise(checks);
    const lineFor = (check) => `${check.label}: ${check.status === 'ok' && check.detail === 'Ready' ? 'Ready' : check.detail}`;
    const groupLines = (group) => checks.filter((check) => check.group === group).map(lineFor);

    const setupLines = [
      `Slash commands: ${ctx.appConfig.discord.enableSlashCommands ? 'Enabled' : 'Disabled'}`,
      `Prefix commands in this server: ${ctx.config.prefixEnabled === false ? 'Off' : 'On'}`,
      ...groupLines('Setup'),
    ];
    if (me) {
      const highest = me.roles.highest;
      setupLines.push(`Bot role position: ${highest ? highest.position : 'unknown'}`);
    }

    const settings = ticketService.readSettings(ctx.config.misc);
    setupLines.push(`Tickets: ${settings.categoryId && settings.supportRoleId ? 'Configured' : 'Not configured (run ticketsetup)'}`);
    setupLines.push(`Mute role: ${ctx.config.muteRoleEnabled && ctx.config.muteRoleId ? 'Configured' : 'Not set'}`);

    const channelPerms = me && ctx.channel && typeof ctx.channel.permissionsFor === 'function'
      ? ctx.channel.permissionsFor(me)
      : null;
    const canSend = channelPerms ? channelPerms.has(PermissionFlagsBits.SendMessages) : false;

    const extraFields = [
      { name: 'Channels', group: 'Channels' },
      { name: 'Ban appeals', group: 'Appeals' },
    ]
      .filter((field) => groupLines(field.group).length > 0)
      .map((field) => ({ name: field.name, value: groupLines(field.group).join('\n').slice(0, 1024), inline: false }));

    await ctx.replyEmbed(baseEmbed({
      title: 'Bot Health Check',
      color: counts.fail > 0 || counts.warn > 0 ? COLORS.notice : COLORS.info,
      description: `Read-only check. Nothing in the server was changed.\n${counts.ok} ok, ${counts.warn} warning${counts.warn === 1 ? '' : 's'}, ${counts.fail} problem${counts.fail === 1 ? '' : 's'}.`,
      fields: [
        { name: 'Setup', value: setupLines.join('\n').slice(0, 1024), inline: false },
        { name: 'Command groups', value: groupLines('Permissions').join('\n').slice(0, 1024), inline: false },
        ...extraFields,
        { name: 'This channel', value: canSend ? 'The bot can send messages here.' : 'The bot cannot send messages here.', inline: false },
      ],
      footer: guild.name,
    }));
  },
};
