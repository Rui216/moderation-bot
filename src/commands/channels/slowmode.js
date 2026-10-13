'use strict';

/** Set or clear slowmode for a channel. */

const args = require('../../utils/args');
const { ValidationError } = require('../../utils/errors');
const channelService = require('../../services/channelService');

module.exports = {
  name: 'slowmode',
  aliases: ['slow'],
  description: 'Set slowmode for a channel, or clear it with 0.',
  usage: 'slowmode [channel] <seconds> [reason]',
  examples: ['slowmode 10 Calming a busy channel', 'slowmode 0', 'slowmode #general 30'],
  permission: 'moderator',
  action: 'slowmode',
  slashOptions: [
    { name: 'seconds', type: 'integer', required: true },
    { name: 'channel', type: 'channel', required: false },
    { name: 'reason', type: 'string', required: false },
  ],

  async execute(ctx) {
    let channel = ctx.channel;
    let seconds = Number.parseInt(ctx.args[0], 10);

    // Optional channel argument: "slowmode #channel 30".
    if (!Number.isFinite(seconds)) {
      const resolved = await args.resolveChannelArg(ctx, { index: 0, required: false });
      if (resolved) {
        channel = resolved;
        seconds = Number.parseInt(ctx.args[1], 10);
      }
    }

    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new ValidationError('Provide the slowmode in seconds, for example: slowmode 10');
    }

    const reasonTokens = ctx.args.slice(1).filter((token) => !/^\d+$/.test(token) && !token.startsWith('<#'));
    const reason = reasonTokens.length > 0
      ? args.buildReason(ctx, reasonTokens, { fallback: 'Slowmode updated' })
      : 'Slowmode updated';

    const result = await channelService.slowmode(ctx, channel, seconds, reason);
    await ctx.replyEmbed(result.embed);
  },
};
