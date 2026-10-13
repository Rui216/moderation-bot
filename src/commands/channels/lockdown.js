'use strict';

/**
 * Lock down a channel, or the whole server when no channel is given.
 *
 * The channels and roles affected come from the guild's lockdown defaults set
 * in the setup wizard, and an automatic unlock can be scheduled when the guild
 * configures one.
 */

const args = require('../../utils/args');
const channelService = require('../../services/channelService');

module.exports = {
  name: 'lockdown',
  aliases: ['lock'],
  description: 'Lock a channel, or the whole server when no channel is specified.',
  usage: 'lockdown [channel] <reason>',
  examples: ['lockdown Raid in progress', 'lockdown #general Heated argument'],
  permission: 'moderator',
  action: 'lockdown',
  slashOptions: [
    { name: 'channel', type: 'channel', required: false },
    { name: 'reason', type: 'string', required: false },
  ],

  async execute(ctx) {
    const channel = await args.resolveChannelArg(ctx, { index: 0, required: false });
    const reasonTokens = channel ? ctx.args.slice(1) : ctx.args;
    const reason = args.buildReason(ctx, reasonTokens, { fallback: 'Lockdown' });

    const result = await channelService.lockdown(ctx, channel || null);
    await ctx.replyEmbed({ ...result.embed, description: result.embed.description || reason });
  },
};
