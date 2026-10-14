'use strict';

/** Post the "Open Ticket" panel into a channel. */

const args = require('../../utils/args');
const ticketService = require('../../services/ticketService');
const { repo } = require('../../db');
const { baseEmbed } = require('../../utils/embeds');
const { COLORS } = require('../../config/constants');

module.exports = {
  name: 'ticketpanel',
  aliases: [],
  description: 'Post the ticket panel with an Open Ticket button.',
  usage: 'ticketpanel [channel]',
  examples: ['ticketpanel', 'ticketpanel #help'],
  permission: 'admin',
  action: null,
  slashOptions: [
    { name: 'channel', type: 'channel', required: false, description: 'Where to post the panel (default: this channel)' },
  ],

  async execute(ctx) {
    const target = (await args.resolveChannelArg(ctx, { index: 0, required: false })) || ctx.channel;
    const config = await repo('guilds').getConfig(ctx.guild.id, { force: true });
    await ticketService.postPanel(ctx.guild, target, config);

    await ctx.replyEmbed(baseEmbed({
      title: 'Ticket Panel Posted',
      color: COLORS.success,
      description: `The panel is now in <#${target.id}>.`,
      footer: ctx.guild.name,
    }));
  },
};
