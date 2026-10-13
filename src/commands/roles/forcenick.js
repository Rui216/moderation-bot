'use strict';

/**
 * Force or reset a member nickname.
 *   forcenick @User New Name    set a nickname
 *   forcenick @User reset       restore the original username
 */

const args = require('../../utils/args');
const channelService = require('../../services/channelService');

module.exports = {
  name: 'forcenick',
  aliases: ['fn', 'setnick'],
  description: 'Set or reset a member nickname.',
  usage: 'forcenick <member> <nickname | reset> [reason]',
  examples: ['forcenick @User Troublemaker', 'forcenick @User reset'],
  permission: 'moderator',
  action: 'forcenick',
  slashOptions: [
    { name: 'member', type: 'member', required: true },
    { name: 'nickname', type: 'string', required: true },
    { name: 'reason', type: 'string', required: false },
  ],

  async execute(ctx) {
    const target = await args.resolveMember(ctx);
    const nicknameArg = ctx.args[1];
    const reset = !nicknameArg || ['reset', 'clear', 'none', 'remove'].includes(String(nicknameArg).toLowerCase());

    const reasonTokens = reset ? ctx.args.slice(2) : ctx.args.slice(2);
    const reason = reasonTokens.length > 0
      ? args.buildReason(ctx, reasonTokens, { fallback: reset ? 'Nickname reset' : 'Nickname set' })
      : (reset ? 'Nickname reset' : 'Nickname set');

    const result = await channelService.forceNickname(ctx, target, reset ? null : nicknameArg, reason);
    await ctx.replyEmbed(result.embed);
  },
};
