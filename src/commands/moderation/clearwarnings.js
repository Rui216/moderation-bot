'use strict';

/** Clear every active warning for a member. */

const args = require('../../utils/args');
const punishmentService = require('../../services/punishmentService');

module.exports = {
  name: 'clearwarnings',
  aliases: ['clearwarns', 'resetwarnings'],
  description: 'Clear all active warnings for a member.',
  usage: 'clearwarnings <member> <reason>',
  examples: ['clearwarnings @User Successful appeal'],
  permission: 'moderator',
  action: 'warn',
  slashOptions: [
    { name: 'member', type: 'member', required: true },
    { name: 'reason', type: 'string', required: false },
  ],

  async execute(ctx) {
    const target = await args.resolveMember(ctx);
    const reason = ctx.args.length > 1
      ? args.buildReason(ctx, ctx.args.slice(1), { fallback: 'All warnings cleared' })
      : 'All warnings cleared';

    const { cleared, record } = await punishmentService.clearWarnings(ctx, target, reason);

    await ctx.replyEmbed({
      ...record.embed,
      description: cleared === 0
        ? 'That member had no active warnings.'
        : `${cleared} warning${cleared === 1 ? '' : 's'} cleared for ${target.user.tag}.`,
    });
  },
};
