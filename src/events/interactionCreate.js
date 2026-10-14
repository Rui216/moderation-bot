'use strict';

const { EPHEMERAL } = require('../utils/flags');

/**
 * Interaction routing: setup wizard components first, then slash commands.
 */

const dispatcher = require('../core/dispatcher');
const setupWizard = require('../core/setupWizard');
const ticketService = require('../services/ticketService');
const appealService = require('../services/appealService');
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
    // Ban appeals: these arrive from direct messages too, so they run before the guild-only handlers.
    if (String(interaction.customId || '').startsWith('appeal:')) {
      const appealHandled = await appealService.handleInteraction(client, deps, interaction);
      if (appealHandled) return;
    }

    if (interaction.isButton() || interaction.isAnySelectMenu()) {
      const ticketHandled = await ticketService.handleComponent(client, interaction);
      if (ticketHandled) return;

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
      await interaction.reply({ embeds: [errorEmbed({ title: 'Command Failed' })], flags: EPHEMERAL }).catch(() => null);
    }
  }
}

module.exports = { register, handle };
