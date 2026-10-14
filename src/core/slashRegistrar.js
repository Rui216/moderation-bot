'use strict';

/**
 * Slash command registration.
 *
 * Every command that declares slashOptions is published as an application
 * command. Global registration makes the commands available in every server
 * the bot is in, but Discord can take up to an hour to show new global
 * commands. When SLASH_DEV_GUILD_ID is set, the same commands are also
 * registered to that guild, where they appear immediately.
 */

const { SlashCommandBuilder, Routes } = require('discord.js');
const registry = require('./registry');
const { logger } = require('../utils/logger');

const log = logger.child('slash');

/** Map the textual option types used in command definitions to builders. */
function applyOptions(builder, options) {
  for (const option of options || []) {
    const required = option.required !== false;
    const description = (option.description || option.name).slice(0, 100);

    switch (option.type) {
      case 'user':
      case 'member':
        builder.addUserOption((o) => o.setName(option.name).setDescription(description).setRequired(required));
        break;
      case 'channel':
        builder.addChannelOption((o) => o.setName(option.name).setDescription(description).setRequired(required));
        break;
      case 'role':
        builder.addRoleOption((o) => o.setName(option.name).setDescription(description).setRequired(required));
        break;
      case 'integer':
        builder.addIntegerOption((o) => o.setName(option.name).setDescription(description).setRequired(required));
        break;
      case 'boolean':
        builder.addBooleanOption((o) => o.setName(option.name).setDescription(description).setRequired(required));
        break;
      default:
        builder.addStringOption((o) => o.setName(option.name).setDescription(description).setRequired(required));
    }
  }
  return builder;
}

/** Build the REST body for every registered command that declares slash options. */
function buildSlashBody() {
  return registry.all()
    .filter((command) => Array.isArray(command.slashOptions))
    .map((command) => {
      const builder = new SlashCommandBuilder()
        .setName(command.name)
        .setDescription(command.description.slice(0, 100));
      return applyOptions(builder, command.slashOptions).toJSON();
    });
}

/**
 * Publish the slash commands. Called once the client is ready.
 * @param {import('discord.js').Client} client
 * @param {object} appConfig
 * @returns {Promise<{global: number, guild: number}>}
 */
async function registerAll(client, appConfig) {
  const body = buildSlashBody();
  const result = { global: 0, guild: 0 };

  await client.rest.put(Routes.applicationCommands(client.user.id), { body });
  result.global = body.length;

  const devGuild = appConfig.discord.slashDevGuildId;
  if (devGuild) {
    await client.rest.put(Routes.applicationGuildCommands(client.user.id, devGuild), { body });
    result.guild = body.length;
  }

  log.info('Slash commands registered', result);
  return result;
}

module.exports = { applyOptions, buildSlashBody, registerAll };
