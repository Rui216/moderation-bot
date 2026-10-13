'use strict';

/**
 * Permission-aware help.
 *
 * Only commands the caller can actually run are listed, so the output doubles as
 * a permission reference. Command details are shown for a single command when
 * a name is supplied.
 */

const { COLORS } = require('../../config/constants');
const { baseEmbed, emptyEmbed, errorEmbed } = require('../../utils/embeds');
const { MESSAGES } = require('../../config/constants');
const registry = require('../../core/registry');

module.exports = {
  name: 'help',
  aliases: ['h', 'commands'],
  description: 'List the commands you can use, or show details for one command.',
  usage: 'help [command]',
  examples: ['help', 'help ban'],
  permission: 'everyone',
  action: null,
  slashOptions: [
    { name: 'command', type: 'string', required: false },
  ],

  async execute(ctx) {
    const query = ctx.args[0];

    if (query) {
      const command = registry.get(query);
      if (!command) {
        await ctx.replyEmbed(emptyEmbed('Unknown Command', `No command named "${query}" exists.`));
        return;
      }

      const visible = registry.visibleFor(ctx.member, ctx.config, ctx.appConfig.discord.ownerIds);
      if (!visible.some((entry) => entry.name === command.name)) {
        await ctx.replyEmbed(errorEmbed({ title: 'Command Failed', description: MESSAGES.noPermission }));
        return;
      }

      await ctx.replyEmbed(baseEmbed({
        title: `Command: ${command.name}`,
        description: command.description,
        color: COLORS.info,
        fields: [
          { name: 'Usage', value: `\`${ctx.config.prefix || ctx.appConfig.discord.defaultPrefix}${command.usage}\``, inline: false },
          { name: 'Permission', value: command.permission, inline: true },
          { name: 'Category', value: command.category, inline: true },
          ...(command.aliases && command.aliases.length > 0
            ? [{ name: 'Aliases', value: command.aliases.join(', '), inline: false }]
            : []),
          ...(command.examples && command.examples.length > 0
            ? [{ name: 'Examples', value: command.examples.map((example) => `${ctx.config.prefix || ctx.appConfig.discord.defaultPrefix}${example}`).join('\n'), inline: false }]
            : []),
        ],
        footer: ctx.guild.name,
      }));
      return;
    }

    const groups = registry.groupedFor(ctx.member, ctx.config, ctx.appConfig.discord.ownerIds);
    const prefix = ctx.config.prefix || ctx.appConfig.discord.defaultPrefix;

    if (groups.length === 0) {
      await ctx.replyEmbed(emptyEmbed('No Commands Available', 'You do not have access to any commands in this server.'));
      return;
    }

    const fields = groups.slice(0, 10).map((group) => ({
      name: group.label,
      value: group.commands
        .map((command) => `\`${prefix}${command.name}\` - ${command.description}`)
        .join('\n')
        .slice(0, 1024),
      inline: false,
    }));

    const status = [];
    if (ctx.config.prefixEnabled === false) status.push('prefix commands are currently disabled in this server');
    if (ctx.config.slashEnabled) status.push('slash commands are enabled');

    await ctx.replyEmbed(baseEmbed({
      title: 'Command Reference',
      description: [
        `Prefix: \`${prefix}\`. You can also mention the bot followed by a command name.`,
        `Run \`${prefix}help <command>\` for usage and examples.`,
        status.length > 0 ? `Note: ${status.join(', ')}.` : null,
      ].filter(Boolean).join('\n'),
      color: COLORS.info,
      fields,
      footer: `${ctx.guild.name} | ${groups.reduce((total, group) => total + group.commands.length, 0)} commands available to you`,
    }));
  },
};
