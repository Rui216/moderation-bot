'use strict';

/**
 * Mute a member using Discord's native timeout.
 *
 * A duration may be supplied; the native timeout always requires one, so a
 * default of 60 minutes is used when the caller omits it.
 */

const args = require('../../utils/args');
const punishmentService = require('../../services/punishmentService');
const { ValidationError } = require('../../utils/errors');
const { formatDuration } = require('../../utils/duration');

/** Duration applied when the caller does not specify one. */
const DEFAULT_MUTE_MS = 60 * 60 * 1000;

module.exports = {
  name: 'mute',
  aliases: ['timeout', 'to'],
  description: 'Mute a member with Discord native timeout. Optionally specify a duration.',
  usage: 'mute <member> [duration] <reason>',
  examples: ['mute @User 10m Excessive pings', 'mute @User Behaviour in voice chat'],
  permission: 'moderator',
  action: 'mute',
  slashOptions: [
    { name: 'member', type: 'member', required: true },
    { name: 'duration', type: 'string', required: false },
    { name: 'reason', type: 'string', required: false },
  ],

  async execute(ctx) {
    const target = await args.resolveMember(ctx);
    const parsed = args.takeDuration(ctx.args.slice(1));

    if (parsed.invalid) {
      throw new ValidationError(`That duration could not be read (${parsed.invalid}). Use a value such as 10m or 2h.`);
    }

    const durationMs = parsed.durationMs || DEFAULT_MUTE_MS;
    if (durationMs > ctx.limits.maxTimeoutMs) {
      throw new ValidationError(`The maximum mute length is ${formatDuration(ctx.limits.maxTimeoutMs)}.`);
    }

    const reason = args.buildReason(ctx, parsed.rest);

    const result = await punishmentService.mute(ctx, target, {
      reason,
      durationMs,
      temporary: Boolean(parsed.durationMs),
      evidenceUrl: ctx.flags.evidence || null,
    });

    await ctx.replyEmbed(result.embed);
  },
};
