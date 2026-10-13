'use strict';

/**
 * Interaction routing: setup wizard components first, then slash commands.
 */

const dispatcher = require('../core/dispatcher');
const setupWizard = require('../core/setupWizard');
const { errorEmbed } = require('../utils/embeds');
const { logger } = require('../utils/logger');

const log = logger.child('events');

function register(client, deps) {
  client.on('interactionCreate', (interaction) => {
    void handle(client, deps, interaction);
  });
}

async function handle(client, deps, interaction) {
  try {
    if (interaction.isButton() || interaction.isAnySelectMenu()) {
      const consumed = await setupWizard.handleComponent(client, interaction);
      if (consumed) return;
    }

    if (interaction.isChatInputCommand()) {
      await dispatcher.handleInteraction(deps, interaction);
      return;
    }

    if (interaction.isAutocomplete()) {
      // Autocomplete is not required by any command; acknowledge quietly.
      await interaction.respond([]).catch(() => null);
    }
  } catch (error) {
    log.error('Interaction handling failed', {
      type: interaction.type,
      code: error && error.code,
      message: error && error.message,
    });

    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ embeds: [errorEmbed({ title: 'Command Failed' })], ephemeral: true }).catch(() => null);
    }
  }
}

module.exports = { register, handle };
