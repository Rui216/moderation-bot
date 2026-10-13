'use strict';

/**
 * Temporarily mute a member.
 *
 * Functionally close to mute with a duration, but the expiry task records the
 * scheduled unmute explicitly, which is what appears in the pending task queue.
 */

const args = require('../../utils/args');
const punishmentService = require('../../services/punishmentService');
const { ValidationError } = require('../../utils/errors');
const { formatDuration } = require('../../utils/duration');

module.exports = {
  name: 'tempmute',
  aliases: ['tmute'],
  description: 'Mute a member for a set time, then unmute them automatically.',
  usage: 'tempmute <member> <duration> <reason>',
  examples: ['tempmute @User 45m Arguing in general'],
  permission: 'moderator',
  action: 'mute',
  slashOptions: [
    { name: 'member', type: 'member', required: true },
    { name: 'duration', type: 'string', required: true },
    { name: 'reason', type: 'string', required: false },
  ],

  async execute(ctx) {
    const target = await args.resolveMember(ctx);
    const parsed = args.takeDuration(ctx.args.slice(1));

    if (parsed.durationMs === null) {
      throw new ValidationError('Provide a duration, for example 45m or 6h.');
    }
    if (parsed.durationMs > ctx.limits.maxTimeoutMs) {
      throw new ValidationError(`The maximum mute length is ${formatDuration(ctx.limits.maxTimeoutMs)}.`);
    }

    const reason = args.buildReason(ctx, parsed.rest);

    const result = await punishmentService.mute(ctx, target, {
      reason,
      durationMs: parsed.durationMs,
      temporary: true,
      evidenceUrl: ctx.flags.evidence || null,
    });

    await ctx.replyEmbed(result.embed);
  },
};
