'use strict';

/**
 * Interaction routing: setup wizard components first, then slash commands.
 */

const dispatcher = require('../core/dispatcher');
const setupWizard = require('../core/setupWizard');
const ticketService = require('../services/ticketService');
const ticketSetupWizard = require('../core/ticketSetupWizard');
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
    if (interaction.isButton() || interaction.isAnySelectMenu() || interaction.isModalSubmit()) {
      if (await ticketSetupWizard.handleComponent(client, interaction)) return;
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

    if (interaction.isRepliable()) {
      const payload = { embeds: [errorEmbed({ title: 'Command Failed' })] };
      if (interaction.deferred && !interaction.replied) await interaction.editReply(payload).catch(() => null);
      else if (!interaction.replied) await interaction.reply({ ...payload, ephemeral: true }).catch(() => null);
    }
  }
}

module.exports = { register, handle };
