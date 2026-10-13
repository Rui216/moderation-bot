'use strict';

/**
 * Lock a member nickname so any change is reverted automatically.
 * Run without a nickname to remove the lock.
 */

const args = require('../../utils/args');
const channelService = require('../../services/channelService');

module.exports = {
  name: 'nicklock',
  aliases: ['locknick'],
  description: 'Lock a member nickname so changes are reverted, or remove an existing lock.',
  usage: 'nicklock <member> [nickname] [reason]',
  examples: ['nicklock @User Staff Member', 'nicklock @User'],
  permission: 'moderator',
  action: 'forcenick',
  slashOptions: [
    { name: 'member', type: 'member', required: true },
    { name: 'nickname', type: 'string', required: false },
    { name: 'reason', type: 'string', required: false },
  ],

  async execute(ctx) {
    const target = await args.resolveMember(ctx);
    const nickname = ctx.args[1] && !ctx.args[1].startsWith('--') ? ctx.args[1] : null;
    const reasonTokens = nickname ? ctx.args.slice(2) : ctx.args.slice(1);

    const reason = reasonTokens.length > 0
      ? args.buildReason(ctx, reasonTokens, { fallback: nickname ? 'Nickname locked' : 'Nickname lock removed' })
      : (nickname ? 'Nickname locked' : 'Nickname lock removed');

    const result = await channelService.toggleNicknameLock(ctx, target, nickname, reason);
    await ctx.replyEmbed(result.embed);
  },
};
