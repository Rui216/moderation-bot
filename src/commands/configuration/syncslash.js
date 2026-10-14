'use strict';

/**
 * Register application (slash) commands for this server.
 *
 * Slash commands are an optional hybrid mode. Prefix commands remain the
 * primary interface and work standalone. Registering per guild is instant,
 * while global registration can take up to an hour to propagate - which is why
 * the wizard and this command default to a single guild.
 */

const { Routes } = require('discord.js');

const { COLORS } = require('../../config/constants');
const { baseEmbed, errorEmbed, successEmbed } = require('../../utils/embeds');
const { logger } = require('../../utils/logger');
const registryModel = require('../../core/registry');
const { applyOptions } = require('../../core/slashRegistrar');
const { SlashCommandBuilder } = require('discord.js');

const log = logger.child('command');

module.exports = {
  name: 'syncslash',
  aliases: ['registerslash'],
  description: 'Register slash commands for this server (optional hybrid mode).',
  usage: 'syncslash [clear]',
  examples: ['syncslash', 'syncslash clear'],
  permission: 'admin',
  action: 'setup',
  slashOptions: [
    { name: 'action', type: 'string', required: false },
  ],

  async execute(ctx) {
    const appConfig = ctx.appConfig;

    if (!appConfig.discord.enableSlashCommands) {
      await ctx.replyEmbed(errorEmbed({
        title: 'Slash Commands Disabled',
        description: 'Slash support is turned off in the bot configuration (ENABLE_SLASH_COMMANDS). '
          + 'Set it to true in the environment and restart the bot, then run this command again.',
        color: COLORS.notice,
      }));
      return;
    }

    const clearing = String(ctx.args[0] || '').toLowerCase() === 'clear';
    const commands = registryModel.all().filter((command) => Array.isArray(command.slashOptions));

    if (clearing) {
      await ctx.client.rest.put(Routes.applicationGuildCommands(ctx.client.user.id, ctx.guild.id), { body: [] });
      await ctx.replyEmbed(successEmbed({
        title: 'Slash Commands Cleared',
        color: COLORS.success,
        description: `Removed every guild slash command from ${ctx.guild.name}.`,
        footer: ctx.guild.name,
      }));
      return;
    }

    if (commands.length === 0) {
      await ctx.replyEmbed(errorEmbed({
        title: 'Nothing To Register',
        description: 'No commands declare slash options, so there is nothing to register.',
      }));
      return;
    }

    const body = commands.map((command) => {
      const builder = new SlashCommandBuilder()
        .setName(command.name)
        .setDescription(command.description.slice(0, 100));
      return applyOptions(builder, command.slashOptions).toJSON();
    });

    // Guild registration is instant; global registration is used when no guild
    // target is configured, at the cost of propagation delay.
    const target = appConfig.discord.slashDevGuildId || ctx.guild.id;
    await ctx.client.rest.put(Routes.applicationGuildCommands(ctx.client.user.id, target), { body });

    log.info('Slash commands registered', { guildId: target, count: body.length });

    await ctx.replyEmbed(baseEmbed({
      title: 'Slash Commands Registered',
      color: COLORS.success,
      description: `Registered ${body.length} commands for this server. They appear immediately.`,
      fields: [
        { name: 'Registered By', value: `<@${ctx.author.id}>`, inline: true },
        { name: 'Scope', value: 'This server only', inline: true },
        { name: 'Note', value: 'Prefix commands remain the primary interface. Slash commands are an optional hybrid mode.', inline: false },
      ],
      footer: ctx.guild.name,
    }));
  },
};
