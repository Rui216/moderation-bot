'use strict';

/**
 * Softban: ban and immediately unban a member to remove their recent messages
 * without leaving a permanent ban in place.
 */

const args = require('../../utils/args');
const punishmentService = require('../../services/punishmentService');

module.exports = {
  name: 'softban',
  aliases: ['sban'],
  description: 'Ban then immediately unban a member to remove their recent messages.',
  usage: 'softban <member> <reason>',
  examples: ['softban @User Spamming invite links'],
  permission: 'moderator',
  action: 'ban',
  slashOptions: [
    { name: 'member', type: 'member', required: true },
    { name: 'reason', type: 'string', required: false },
  ],

  async execute(ctx) {
    const target = await args.resolveMember(ctx);
    const reason = args.buildReason(ctx, ctx.args.slice(1));

    const result = await punishmentService.ban(ctx, target, {
      reason,
      softban: true,
      evidenceUrl: ctx.flags.evidence || null,
    });

    await ctx.replyEmbed(result.embed);
  },
};
