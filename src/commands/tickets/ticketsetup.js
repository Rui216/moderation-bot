'use strict';

const tickets = require('../../services/ticketService');
const wizard = require('../../core/ticketSetupWizard');
const { repo } = require('../../db');
const { ValidationError } = require('../../utils/errors');
const { successEmbed } = require('../../utils/embeds');

module.exports = {
  name: 'ticketsetup', aliases: ['ticketconfig'],
  description: 'Interactively configure tickets, preview the panel, and publish it.',
  usage: 'ticketsetup [category] [support role] [log channel]',
  examples: ['ticketsetup', 'ticketsetup 123456789012345678 @Support #ticket-log'],
  permission: 'admin', action: null,
  slashOptions: [
    { name: 'category', type: 'channel', required: false, description: 'Category that holds ticket channels' },
    { name: 'support_role', type: 'role', required: false, description: 'Role that can read and answer tickets' },
    { name: 'log_channel', type: 'channel', required: false, description: 'Channel that receives transcripts' },
  ],
  async execute(ctx) {
    if (!ctx.args.some((arg) => arg?.trim())) return wizard.start(ctx);
    const values = {};
    // Preserve positional holes from optional slash options. A log-only update is not a category.
    for (const [index, field] of ['categoryId', 'supportRoleId', 'logChannelId'].entries()) {
      const value = ctx.args[index];
      if (!value) continue;
      const match = value.match(/^(?:<#|<@&)?(\d{17,20})>?$/);
      if (!match) throw new ValidationError('Use category ID, support role mention, and log channel mention in that order, or run ticketsetup without arguments.');
      values[field] = match[1];
    }
    if (ctx.args.length > 3) throw new ValidationError('Too many arguments. Run ticketsetup without arguments for the interactive wizard.');
    const config = await repo('guilds').getConfig(ctx.guild.id, { force: true });
    await tickets.validateSetup(ctx.guild, { ...tickets.readSettings(config.misc), ...values });
    const saved = await tickets.saveSetup(ctx.guild.id, values);
    await ctx.replyEmbed(successEmbed({ title: 'Ticket Settings Saved', description:
      `Category: <#${saved.categoryId}>\nSupport: <@&${saved.supportRoleId}>\nTranscripts: <#${saved.logChannelId}>\nRun ticketsetup without arguments to customize and publish your panel.` }));
  },
};
