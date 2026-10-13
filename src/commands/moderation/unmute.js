'use strict';

/** Remove a mute and cancel any pending unmute task for that member. */

const args = require('../../utils/args');
const punishmentService = require('../../services/punishmentService');

module.exports = {
  name: 'unmute',
  aliases: ['untimeout', 'uto'],
  description: 'Remove a member mute and cancel the scheduled unmute.',
  usage: 'unmute <member> <reason>',
  examples: ['unmute @User Mute applied by mistake'],
  permission: 'moderator',
  action: 'mute',
  slashOptions: [
    { name: 'member', type: 'member', required: true },
    { name: 'reason', type: 'string', required: false },
  ],

  async execute(ctx) {
    const target = await args.resolveMember(ctx);
    const reason = args.buildReason(ctx, ctx.args.slice(1), { fallback: 'Mute removed' });

    const result = await punishmentService.unmute(ctx, target, { reason });
    await ctx.replyEmbed(result.embed);
  },
};
