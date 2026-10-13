'use strict';

/** Kick a member. Responds with the shared moderation embed. */

const args = require('../../utils/args');
const punishmentService = require('../../services/punishmentService');

module.exports = {
  name: 'kick',
  aliases: ['k'],
  description: 'Kick a member from the server.',
  usage: 'kick <member> <reason>',
  examples: ['kick @User Repeatedly ignoring channel rules', 'kick 123456789012345678 Inappropriate avatar'],
  permission: 'moderator',
  action: 'kick',
  slashOptions: [
    { name: 'member', type: 'member', required: true },
    { name: 'reason', type: 'string', required: false },
  ],

  async execute(ctx) {
    const target = await args.resolveMember(ctx);
    const reason = args.buildReason(ctx, ctx.args.slice(1));

    const result = await punishmentService.kick(ctx, target, {
      reason,
      evidenceUrl: ctx.flags.evidence || null,
    });

    await ctx.replyEmbed(result.embed);
  },
};
