'use strict';

/**
 * Manage the command prefix for this server.
 *
 *   prefix                 show the current prefix and state
 *   prefix <new prefix>    change the prefix
 *   prefix enable|disable  toggle prefix commands entirely
 */

const { COLORS } = require('../../config/constants');
const { baseEmbed, successEmbed } = require('../../utils/embeds');
const { sanitizePrefix } = require('../../utils/sanitize');
const { ValidationError } = require('../../utils/errors');
const { repo } = require('../../db');

module.exports = {
  name: 'prefix',
  aliases: ['setprefix'],
  description: 'View or change the command prefix, or enable and disable prefix commands.',
  usage: 'prefix [new prefix | enable | disable]',
  examples: ['prefix', 'prefix ?', 'prefix disable'],
  permission: 'admin',
  action: null,
  slashOptions: [
    { name: 'value', type: 'string', required: false },
  ],

  async execute(ctx) {
    const value = ctx.args[0];
    const currentPrefix = ctx.config.prefix || ctx.appConfig.discord.defaultPrefix;

    if (!value) {
      await ctx.replyEmbed(baseEmbed({
        title: 'Command Prefix',
        color: COLORS.info,
        fields: [
          { name: 'Current Prefix', value: `\`${currentPrefix}\``, inline: true },
          { name: 'Custom Prefix', value: ctx.config.prefix ? `\`${ctx.config.prefix}\`` : 'Not set (using the default)', inline: true },
          { name: 'Prefix Commands', value: ctx.config.prefixEnabled === false ? 'Disabled' : 'Enabled', inline: true },
          { name: 'Example', value: `\`${currentPrefix}help\``, inline: false },
        ],
        description: 'Set a new prefix with the prefix command, or enable and disable prefix commands entirely.',
        footer: ctx.guild.name,
      }));
      return;
    }

    const normalized = String(value).toLowerCase();

    if (normalized === 'enable' || normalized === 'disable') {
      const enabled = normalized === 'enable';
      await repo('guilds').updateConfig(ctx.guild.id, { prefixEnabled: enabled });

      await ctx.replyEmbed(successEmbed({
        title: enabled ? 'Prefix Commands Enabled' : 'Prefix Commands Disabled',
        color: COLORS.success,
        description: enabled
          ? `Members can use \`${currentPrefix}\` commands again.`
          : 'Prefix commands are now ignored. Enable them again with the prefix enable command, or use the setup wizard.',
        fields: [
          { name: 'Changed By', value: `<@${ctx.author.id}>`, inline: true },
          { name: 'Prefix', value: `\`${currentPrefix}\``, inline: true },
        ],
        footer: ctx.guild.name,
      }));
      return;
    }

    const prefix = sanitizePrefix(value);
    if (!prefix) {
      throw new ValidationError('That prefix cannot be used. Choose one with up to 5 characters and no spaces, mentions, or backticks.');
    }

    await repo('guilds').updateConfig(ctx.guild.id, { prefix, prefixEnabled: true });

    await ctx.replyEmbed(successEmbed({
      title: 'Prefix Updated',
      color: COLORS.success,
      description: `The command prefix is now \`${prefix}\`. Example: \`${prefix}help\``,
      fields: [
        { name: 'Changed By', value: `<@${ctx.author.id}>`, inline: true },
        { name: 'Previous Prefix', value: `\`${currentPrefix}\``, inline: true },
      ],
      footer: ctx.guild.name,
    }));
  },
};
