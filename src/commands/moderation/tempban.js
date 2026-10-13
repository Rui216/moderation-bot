'use strict';

/**
 * Temporarily ban a member. An expiry task is written to the database, so the
 * unban happens even if the bot restarts while the ban is pending.
 */

const args = require('../../utils/args');
const punishmentService = require('../../services/punishmentService');
const { ValidationError } = require('../../utils/errors');
const { formatDuration } = require('../../utils/duration');

module.exports = {
  name: 'tempban',
  aliases: ['tban'],
  description: 'Ban a member for a limited time, then unban them automatically.',
  usage: 'tempban <member> <duration> <reason>',
  examples: ['tempban @User 3d Cooling off period'],
  permission: 'moderator',
  action: 'ban',
  slashOptions: [
    { name: 'member', type: 'member', required: true },
    { name: 'duration', type: 'string', required: true },
    { name: 'reason', type: 'string', required: false },
  ],

  async execute(ctx) {
    const target = await args.resolveMember(ctx);
    const parsed = args.takeDuration(ctx.args.slice(1));

    if (parsed.durationMs === null) {
      throw new ValidationError('Provide a duration, for example 3d, 12h, or 90m.');
    }

    const reason = args.buildReason(ctx, parsed.rest);

    const result = await punishmentService.ban(ctx, target, {
      reason: `${reason} (temporary ban of ${formatDuration(parsed.durationMs)})`,
      durationMs: parsed.durationMs,
      evidenceUrl: ctx.flags.evidence || null,
    });

    await ctx.replyEmbed(result.embed);
  },
};
