'use strict';

/** Server overview with configuration state relevant to moderation. */

const { COLORS } = require('../../config/constants');
const { baseEmbed } = require('../../utils/embeds');
const { formatAbsolute } = require('../../utils/duration');
const { repo } = require('../../db');

module.exports = {
  name: 'serverinfo',
  aliases: ['guildinfo', 'server'],
  description: 'Show server details and the moderation configuration summary.',
  usage: 'serverinfo',
  examples: ['serverinfo'],
  permission: 'everyone',
  action: null,
  slashOptions: [],

  async execute(ctx) {
    const guild = ctx.guild;
    const stats = await repo('guilds').getStats(guild.id).catch(() => null);
    const logging = await repo('guilds').getLogging(guild.id).catch(() => null);
    const automod = await repo('guilds').getAutomod(guild.id).catch(() => null);

    const textChannels = guild.channels.cache.filter((channel) => channel.isTextBased() && !channel.isThread?.()).size;
    const voiceChannels = guild.channels.cache.filter((channel) => channel.type === 2).size;

    const enabledRules = automod
      ? Object.entries(automod.rules || {}).filter(([, rule]) => rule.enabled).map(([rule]) => rule)
      : [];

    const enabledLogEvents = logging
      ? Object.values(logging.events || {}).filter((event) => event && event.enabled).length
      : 0;

    await ctx.replyEmbed(baseEmbed({
      title: `Server: ${guild.name}`,
      color: COLORS.info,
      thumbnail: guild.iconURL({ size: 256 }) || undefined,
      fields: [
        { name: 'Server ID', value: guild.id, inline: true },
        { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true },
        { name: 'Created', value: formatAbsolute(guild.createdTimestamp), inline: true },
        { name: 'Members', value: String(guild.memberCount), inline: true },
        { name: 'Channels', value: `${textChannels} text, ${voiceChannels} voice`, inline: true },
        { name: 'Roles', value: String(guild.roles.cache.size), inline: true },
        { name: 'Moderation Cases', value: stats ? String(stats.cases) : 'unavailable', inline: true },
        { name: 'Active Warnings', value: stats ? String(stats.activeWarnings) : 'unavailable', inline: true },
        { name: 'Pending Actions', value: stats ? String(stats.pendingTasks) : 'unavailable', inline: true },
        {
          name: 'Automod',
          value: automod
            ? `${automod.enabled ? 'Enabled' : 'Disabled'} | active rules: ${enabledRules.join(', ') || 'none'}`
            : 'Unavailable',
          inline: false,
        },
        {
          name: 'Logging',
          value: logging ? `${enabledLogEvents} event types enabled` : 'Unavailable',
          inline: false,
        },
        {
          name: 'Configured',
          value: ctx.config.configured ? 'Yes' : 'No (run the setup command)',
          inline: true,
        },
        {
          name: 'Command Prefix',
          value: `\`${ctx.config.prefix || ctx.appConfig.discord.defaultPrefix}\`${ctx.config.prefixEnabled === false ? ' (disabled)' : ''}`,
          inline: true,
        },
      ],
      footer: guild.name,
    }));
  },
};
