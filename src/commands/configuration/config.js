'use strict';

/**
 * Show the current moderation configuration for this server.
 *
 * Only values the administrator configured are shown: role and channel ids are
 * rendered as mentions so they are meaningful, and no internal database or
 * infrastructure identifiers appear anywhere.
 */

const { COLORS, LOG_EVENTS, AUTOMOD_RULE_LABELS } = require('../../config/constants');
const { baseEmbed, compactFields } = require('../../utils/embeds');
const { repo } = require('../../db');

module.exports = {
  name: 'config',
  aliases: ['settings', 'showconfig'],
  description: 'Show the moderation configuration for this server.',
  usage: 'config',
  examples: ['config'],
  permission: 'admin',
  action: null,
  slashOptions: [],

  async execute(ctx) {
    const [config, logging, automod, stats] = await Promise.all([
      repo('guilds').getConfig(ctx.guild.id, { force: true }),
      repo('guilds').getLogging(ctx.guild.id, { force: true }).catch(() => null),
      repo('guilds').getAutomod(ctx.guild.id, { force: true }).catch(() => null),
      repo('guilds').getStats(ctx.guild.id).catch(() => null),
    ]);

    const mentionRoles = (roleIds) => (roleIds && roleIds.length > 0
      ? roleIds.map((roleId) => `<@&${roleId}>`).join(', ')
      : 'Not configured');

    const fields = [
      {
        name: 'Command Handling',
        value: [
          `Prefix: \`${config.prefix || ctx.appConfig.discord.defaultPrefix}\`${config.prefix ? ' (custom)' : ' (default)'}`,
          `Prefix commands: ${config.prefixEnabled === false ? 'disabled' : 'enabled'}`,
          `Slash commands: ${config.slashEnabled ? 'enabled' : 'disabled'}`,
        ].join('\n'),
        inline: false,
      },
      {
        name: 'Authorization',
        value: [
          `Administrator roles: ${mentionRoles(config.adminRoleIds)}`,
          `Moderator roles: ${mentionRoles(config.modRoleIds)}`,
          `Trusted roles: ${mentionRoles(config.trustedRoleIds)}`,
        ].join('\n'),
        inline: false,
      },
      {
        name: 'Muting',
        value: [
          `Method: Discord native timeout`,
          `Mute role: ${config.muteRoleEnabled && config.mutedRoleId ? `<@&${config.mutedRoleId}>` : 'not used'}`,
        ].join('\n'),
        inline: false,
      },
      {
        name: 'Behaviour',
        value: [
          `Reason required: ${config.requireReason ? 'yes' : 'no'}`,
          `Direct message on punishment: ${config.dmOnPunishment ? 'yes' : 'no'}`,
          `Delete command messages: ${config.deleteCommandMessages ? 'yes' : 'no'}`,
        ].join('\n'),
        inline: false,
      },
      {
        name: 'Lockdown Defaults',
        value: [
          `Roles denied send permission: ${config.lockdown && config.lockdown.roleIds.length > 0
            ? config.lockdown.roleIds.map((roleId) => `<@&${roleId}>`).join(', ')
            : '@everyone'}`,
          `Automatic unlock: ${config.lockdown && config.lockdown.autoUnlockMinutes > 0
            ? `${config.lockdown.autoUnlockMinutes} minutes`
            : 'disabled'}`,
        ].join('\n'),
        inline: false,
      },
    ];

    if (logging) {
      const slots = Object.entries(logging.channels || {})
        .filter(([, value]) => Boolean(value))
        .map(([slot, value]) => `${slot}: <#${value}>`);
      const enabledEvents = Object.entries(logging.events || {})
        .filter(([, value]) => value && value.enabled)
        .length;

      fields.push({
        name: 'Logging',
        value: [
          slots.length > 0 ? slots.join('\n') : 'No log channels configured',
          `Event types enabled: ${enabledEvents} of ${Object.keys(LOG_EVENTS).length}`,
          'Use the logconfig command to toggle individual events.',
        ].join('\n'),
        inline: false,
      });
    }

    if (automod) {
      const rules = Object.entries(automod.rules || {})
        .map(([rule, setting]) => `${AUTOMOD_RULE_LABELS[rule] || rule}: ${setting.enabled ? `on (${setting.punishment})` : 'off'}`);
      fields.push({
        name: 'Automod',
        value: [
          `Module: ${automod.enabled ? 'enabled' : 'disabled'}`,
          ...rules,
          `Escalation: ${automod.escalation && automod.escalation.enabled ? `${automod.escalation.steps.length} steps over ${automod.escalation.windowHours}h` : 'disabled'}`,
          `Raid protection: ${automod.raid && automod.raid.enabled ? `${automod.raid.threshold} joins / ${automod.raid.windowSeconds}s, action: ${automod.raid.action}` : 'disabled'}`,
        ].join('\n'),
        inline: false,
      });
    }

    fields.push({
      name: 'Stored Records',
      value: stats
        ? `Cases: ${stats.cases}\nActive warnings: ${stats.activeWarnings}\nStaff notes: ${stats.notes}\nScheduled actions: ${stats.pendingTasks}`
        : 'Unavailable',
      inline: false,
    });

    fields.push({
      name: 'Setup State',
      value: config.configured
        ? `Completed${config.configuredAt ? ` <t:${Math.floor(config.configuredAt / 1000)}:R>` : ''}`
        : 'Not completed. Run the setup command to configure this server.',
      inline: false,
    });

    await ctx.replyEmbed(baseEmbed({
      title: `Configuration: ${ctx.guild.name}`,
      color: COLORS.info,
      fields: compactFields(fields),
      footer: `${ctx.guild.name} | Re-run the setup command to change any of these values`,
    }));
  },
};
