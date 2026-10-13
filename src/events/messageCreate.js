'use strict';

/**
 * Message handling entry point.
 *
 * Order of processing matters:
 *   1. Wizard text input, so a typed prefix value is never treated as a command.
 *   2. Command dispatch, which returns quickly for ordinary chat.
 *   3. Automod, but only for messages that were not commands: staff issuing a
 *      command must never have their own message filtered.
 */

const dispatcher = require('../core/dispatcher');
const setupWizard = require('../core/setupWizard');
const automodService = require('../automod/automodService');
const { repo } = require('../db');
const { logger } = require('../utils/logger');

const log = logger.child('events');

/** Register the message listener. */
function register(client, deps) {
  client.on('messageCreate', (message) => {
    void handle(client, deps, message);
  });
}

async function handle(client, deps, message) {
  try {
    if (!message.guild || message.author.bot) return;

    // 1. Wizard input.
    if (setupWizard.isAwaitingText(message.guild.id, message.author.id)) {
      const consumed = await setupWizard.handleMessage(message);
      if (consumed) return;
    }

    // 2. Commands.
    const handledAsCommand = await dispatcher.handleMessage(deps, message);
    if (handledAsCommand) return;

    // 3. Automod for ordinary messages.
    if (!message.content) return;

    const [config, automod] = await Promise.all([
      repo('guilds').getConfig(message.guild.id),
      repo('guilds').getAutomod(message.guild.id),
    ]);

    await automodService.handleMessage(message, {
      config,
      automod,
      appConfig: deps.appConfig,
    });
  } catch (error) {
    // A failure here must never crash the process; log and continue.
    log.warn('Message handling failed', {
      guildId: message.guild ? message.guild.id : null,
      code: error && error.code,
      message: error && error.message,
    });
  }
}

module.exports = { register, handle };
