'use strict';

/** Close the ticket this command is run in. */

const ticketService = require('../../services/ticketService');
const { repo } = require('../../db');
const { errorEmbed } = require('../../utils/embeds');
const { ValidationError } = require('../../utils/errors');

module.exports = {
  name: 'ticketclose',
  aliases: ['closeticket'],
  description: 'Close the current ticket and save a transcript to the log channel.',
  usage: 'ticketclose',
  examples: ['ticketclose'],
  permission: 'everyone',
  action: null,
  slashOptions: [],

  async execute(ctx) {
    const config = await repo('guilds').getConfig(ctx.guild.id, { force: true });
    const settings = ticketService.readSettings(config.misc);
    const ticket = settings.open[ctx.channel.id];

    if (!ticket) {
      throw new ValidationError('This command only works inside an open ticket.');
    }
    if (!ticketService.canManageTicket(ctx.member, ticket, settings)) {
      await ctx.replyEmbed(errorEmbed({
        title: 'Not Allowed',
        description: 'Only the ticket owner or staff can close this ticket.',
      }));
      return;
    }

    // Both prefix and slash commands require an explicit destructive confirmation.
    const payload = ticketService.closePrompt();
    if (ctx.isSlash) {
      if (ctx.interaction.deferred || ctx.interaction.replied) await ctx.interaction.editReply(payload);
      else await ctx.interaction.reply({ ...payload, ephemeral: true });
    } else await ctx.channel.send(payload);
  },
};
