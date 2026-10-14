'use strict';

/**
 * Lift a lockdown. With no channel argument the whole server is unlocked,
 * including every channel locked with lockdown.
 */

const args = require('../../utils/args');
const channelService = require('../../services/channelService');

module.exports = {
  name: 'unlock',
  aliases: ['unlockdown'],
  description: 'Unlock a channel, or every locked channel when none is specified.',
  usage: 'unlock [channel] <reason>',
  examples: ['unlock Situation resolved', 'unlock #general'],
  permission: 'moderator',
  action: 'unlock',
  slashOptions: [
    { name: 'channel', type: 'channel', required: false },
    { name: 'reason', type: 'string', required: false },
  ],

  async execute(ctx) {
    const channel = await args.resolveChannelArg(ctx, { index: 0, required: false });
    const reasonTokens = channel ? ctx.args.slice(1) : ctx.args;
    ctx.rawReason = args.buildReason(ctx, reasonTokens, { fallback: 'Lockdown lifted' });

    const result = await channelService.unlock(ctx, channel || null);
    await ctx.replyEmbed(result.embed);
  },
};
