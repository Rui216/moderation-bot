'use strict';

/**
 * Command dispatcher.
 *
 * Responsibilities:
 *   - decide whether a message is a command invocation (prefix or mention)
 *   - enforce the guild's prefix enablement setting
 *   - apply the per-user rate limit before anything else happens
 *   - resolve the member's permission level and refuse unauthorized usage
 *   - build the command context, execute, and route errors to safe embeds
 *
 * Unknown commands are ignored rather than answered: a busy server should not
 * receive an error embed every time someone types an exclamation mark.
 */

const { PermissionLevels } = require('../config/constants');
const { logger } = require('../utils/logger');
const { RateLimitError, PermissionError } = require('../utils/errors');
const { errorEmbed } = require('../utils/embeds');
const { CommandContext } = require('./context');
const registry = require('./registry');
const parser = require('../utils/parser');
const permissionService = require('../services/permissionService');
const rateLimitService = require('../services/rateLimitService');
const { repo } = require('../db');

const log = logger.child('dispatcher');

/**
 * Determine the prefix used in this guild, and whether prefix commands are on.
 *
 * @param {object} config guild configuration
 * @param {object} appConfig environment configuration
 * @returns {{prefix: string|null, enabled: boolean}}
 */
function resolvePrefix(config, appConfig) {
  const prefix = config && config.prefix ? config.prefix : appConfig.discord.defaultPrefix;
  const enabled = config ? config.prefixEnabled !== false : true;
  return { prefix, enabled };
}

/**
 * Strip the prefix from a message, returning null when the message is not a
 * command invocation for this bot.
 *
 * @param {import('discord.js').Message} message
 * @param {string} prefix
 * @returns {{name: string, rawArgs: string}|null}
 */
function parseInvocation(message, prefix) {
  const content = message.content;
  if (!content) return null;

  let body = null;

  // Mention invocation always works so a member can discover the prefix.
  const mentionPatterns = [`<@${message.client.user.id}>`, `<@!${message.client.user.id}>`];
  for (const mention of mentionPatterns) {
    if (content.startsWith(mention)) {
      body = content.slice(mention.length).trim();
      break;
    }
  }

  if (body === null) {
    if (!prefix || !content.startsWith(prefix)) return null;
    body = content.slice(prefix.length).trim();
  }

  if (!body) return null;

  const firstSpace = body.search(/\s/);
  const name = (firstSpace === -1 ? body : body.slice(0, firstSpace)).toLowerCase();
  const rawArgs = firstSpace === -1 ? '' : body.slice(firstSpace + 1).trim();

  if (!/^[a-z0-9_-]{1,32}$/i.test(name)) return null;
  return { name, rawArgs };
}

/**
 * Handle an incoming message.
 *
 * @param {object} deps { client, appConfig }
 * @param {import('discord.js').Message} message
 * @returns {Promise<boolean>} true when the message was handled as a command
 */
async function handleMessage(deps, message) {
  const { appConfig } = deps;
  // The message always carries its client, so use it when deps does not.
  const client = deps.client || message.client;

  if (!message.guild) return false;
  if (message.author.bot) return false;

  // Fetch configuration first: the prefix itself is part of the configuration.
  let config;
  try {
    config = await repo('guilds').getConfig(message.guild.id);
  } catch (error) {
    log.warn('Configuration could not be loaded for dispatch', { guildId: message.guild.id, code: error && error.code });
    return false;
  }

  const { prefix, enabled } = resolvePrefix(config, appConfig);

  // A mention-based invocation is allowed even when prefix commands are off,
  // so members can always find out how to use the bot.
  const invocation = parseInvocation(message, prefix);
  if (!invocation) return false;

  const isMentionInvocation = message.content.startsWith(`<@${client.user.id}>`)
    || message.content.startsWith(`<@!${client.user.id}>`);

  if (!enabled && !isMentionInvocation) return false;

  const command = registry.get(invocation.name);
  if (!command) {
    if (isMentionInvocation) {
      await message.reply({
        embeds: [errorEmbed({
          title: 'Unknown Command',
          description: `The bot prefix in this server is "${config.prefix || appConfig.discord.defaultPrefix}". `
            + 'Use the help command to list available commands.',
        })],
      }).catch(() => null);
      return true;
    }
    return false;
  }

  if (command.guildOnly === false && !message.guild) return false;

  // Rate limiting happens before permissions so a flood cannot probe the
  // permission layer, and before any database or API work.
  try {
    rateLimitService.consume(message.guild.id, message.author.id, 'command');
    if (command.action) rateLimitService.consume(message.guild.id, message.author.id, 'action');
  } catch (error) {
    if (error instanceof RateLimitError) {
      await message.reply({ embeds: [errorEmbed({ title: 'Slow Down', description: error.message })] }).catch(() => null);
      return true;
    }
    throw error;
  }

  const check = permissionService.canRunCommand({
    member: message.member,
    config,
    command,
    ownerIds: appConfig.discord.ownerIds,
  });

  if (!check.allowed) {
    await message.reply({
      embeds: [errorEmbed({
        title: 'Command Failed',
        description: new PermissionError().message,
      })],
    }).catch(() => null);
    return true;
  }

  const { flags, args } = parser.extractFlags(parser.tokenize(invocation.rawArgs));

  const ctx = new CommandContext({
    client,
    message,
    command,
    args,
    rawArgs: invocation.rawArgs,
    flags,
    config,
    appConfig,
    level: check.level,
  });

  try {
    await command.execute(ctx);
  } catch (error) {
    await ctx.handleError(error);
  }

  return true;
}

/**
 * Build the argument vector for a slash invocation.
 *
 * Prefix commands are the primary interface. Slash support is an optional
 * hybrid mode, and options are mapped onto the same positional arguments the
 * prefix form uses so both paths share one implementation.
 *
 * @param {object} command command definition
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @returns {string[]}
 */
function buildSlashArgs(command, interaction) {
  const layout = Array.isArray(command.slashOptions) ? command.slashOptions : [];
  const args = [];

  for (const option of layout) {
    const value = interaction.options.get(option.name);
    if (value === null || value === undefined) {
      args.push('');
      continue;
    }

    switch (option.type) {
      case 'user':
        args.push(`<@${value.id}>`);
        break;
      case 'member':
        args.push(`<@${value.id}>`);
        break;
      case 'channel':
        args.push(`<#${value.id}>`);
        break;
      case 'role':
        args.push(`<@&${value.id}>`);
        break;
      case 'boolean':
        args.push(value.value ? 'true' : 'false');
        break;
      default:
        args.push(String(value.value));
    }
  }

  return args;
}

/**
 * Handle a slash command interaction.
 *
 * @param {object} deps { client, appConfig }
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function handleInteraction(deps, interaction) {
  const { client, appConfig } = deps;

  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) {
    await interaction.reply({ embeds: [errorEmbed({ title: 'Unavailable', description: 'This bot only works inside a server.' })], ephemeral: true }).catch(() => null);
    return;
  }

  const command = registry.get(interaction.commandName);
  if (!command) return;

  let config;
  try {
    config = await repo('guilds').getConfig(interaction.guild.id);
  } catch (error) {
    log.warn('Configuration could not be loaded for interaction', { guildId: interaction.guild.id, code: error && error.code });
    await interaction.reply({ embeds: [errorEmbed({ title: 'Command Failed' })], ephemeral: true }).catch(() => null);
    return;
  }

  if (config.slashEnabled === false) {
    await interaction.reply({
      embeds: [errorEmbed({ title: 'Slash Commands Disabled', description: 'Slash commands are turned off in this server. Use the prefix form instead.' })],
      ephemeral: true,
    }).catch(() => null);
    return;
  }

  try {
    rateLimitService.consume(interaction.guild.id, interaction.user.id, 'command');
    if (command.action) rateLimitService.consume(interaction.guild.id, interaction.user.id, 'action');
  } catch (error) {
    if (error instanceof RateLimitError) {
      await interaction.reply({ embeds: [errorEmbed({ title: 'Slow Down', description: error.message })], ephemeral: true }).catch(() => null);
      return;
    }
    throw error;
  }

  const check = permissionService.canRunCommand({
    member: interaction.member,
    config,
    command,
    ownerIds: appConfig.discord.ownerIds,
  });

  if (!check.allowed) {
    await interaction.reply({
      embeds: [errorEmbed({ title: 'Command Failed', description: new PermissionError().message })],
      ephemeral: true,
    }).catch(() => null);
    return;
  }

  const args = buildSlashArgs(command, interaction);
  const ctx = new CommandContext({
    client,
    interaction,
    command,
    args,
    rawArgs: args.join(' '),
    flags: {},
    config,
    appConfig,
    level: check.level,
  });

  try {
    await command.execute(ctx);
  } catch (error) {
    await ctx.handleError(error);
  }
}

module.exports = {
  handleMessage,
  handleInteraction,
  parseInvocation,
  resolvePrefix,
  buildSlashArgs,
  PermissionLevels,
};
