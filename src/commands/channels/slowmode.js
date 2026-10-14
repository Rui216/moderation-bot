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
    let secondsToken;
    let reasonTokens;
    if (ctx.isSlash) {
      secondsToken = ctx.args[0];
      if (ctx.args[1]) channel = await args.resolveChannelArg(ctx, { index: 1, required: true });
      reasonTokens = ctx.args.slice(2);
    } else if (/^\d+$/.test(ctx.args[0] || '') && !/^\d{17,20}$/.test(ctx.args[0])) {
      secondsToken = ctx.args[0];
      reasonTokens = ctx.args.slice(1);
    } else {
      channel = await args.resolveChannelArg(ctx, { index: 0, required: true });
      secondsToken = ctx.args[1];
      reasonTokens = ctx.args.slice(2);
    }
    const seconds = /^\d+$/.test(secondsToken || '') ? Number(secondsToken) : NaN;
    if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 21600) {
      throw new ValidationError('Provide a whole number of seconds between 0 and 21600.');
    }
    const reason = reasonTokens.some((token) => token?.trim())
      ? args.buildReason(ctx, reasonTokens, { fallback: 'Slowmode updated' }) : 'Slowmode updated';

    const result = await channelService.slowmode(ctx, channel, seconds, reason);
    await ctx.replyEmbed(result.embed);
  },
};
