'use strict';

/**
 * Ban a member permanently.
 *
 * A duration can be supplied as the second argument to create a temporary ban
 * without switching commands, e.g. "ban @user 7d reason". The dedicated
 * tempban command does the same thing and exists for discoverability.
 */

const args = require('../../utils/args');
const punishmentService = require('../../services/punishmentService');
const { ValidationError } = require('../../utils/errors');

module.exports = {
  name: 'ban',
  aliases: ['b'],
  description: 'Ban a member from the server. Optionally include a duration to make it temporary.',
  usage: 'ban <member> [duration] <reason>',
  examples: ['ban @User 7d Repeated harassment', 'ban @User Advertising in DMs'],
  permission: 'moderator',
  action: 'ban',
  slashOptions: [
    { name: 'member', type: 'member', required: true },
    { name: 'reason', type: 'string', required: false },
    { name: 'duration', type: 'string', required: false },
  ],

  async execute(ctx) {
    const target = await args.resolveMember(ctx);
    const parsed = args.takeDuration(ctx.args.slice(1));

    if (parsed.invalid) {
      throw new ValidationError(`That duration could not be read (${parsed.invalid}). Use a value such as 1d, 12h, or 30m.`);
    }

    // A duration supplied through the slash "duration" option arrives last.
    const trailing = parsed.durationMs === null && ctx.isSlash ? args.takeDuration([ctx.args[ctx.args.length - 1] || '']) : null;
    const durationMs = parsed.durationMs || (trailing && trailing.durationMs) || null;
    const reasonTokens = trailing && trailing.durationMs ? parsed.rest.slice(0, -1) : parsed.rest;
    const reason = args.buildReason(ctx, reasonTokens);

    const result = await punishmentService.ban(ctx, target, {
      reason,
      durationMs,
      deleteMessageSeconds: Number.isFinite(Number(ctx.flags.purge))
        ? Math.min(Number(ctx.flags.purge) * 86400, 604800)
        : 0,
      evidenceUrl: ctx.flags.evidence || null,
    });

    await ctx.replyEmbed(result.embed);
  },
};
