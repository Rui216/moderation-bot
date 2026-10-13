'use strict';

/**
 * Grant a role temporarily. An expiry task removes it automatically, and the
 * removal survives a bot restart because the task lives in D1.
 */

const args = require('../../utils/args');
const punishmentService = require('../../services/punishmentService');
const { ValidationError } = require('../../utils/errors');

module.exports = {
  name: 'temprole',
  aliases: ['trole'],
  description: 'Give a member a role for a limited time.',
  usage: 'temprole <member> <role> <duration> [reason]',
  examples: ['temprole @User @Event 12h Event access', 'temprole @User @Muted 24h'],
  permission: 'moderator',
  action: 'temprole',
  slashOptions: [
    { name: 'member', type: 'member', required: true },
    { name: 'role', type: 'role', required: true },
    { name: 'duration', type: 'string', required: true },
    { name: 'reason', type: 'string', required: false },
  ],

  async execute(ctx) {
    const target = await args.resolveMember(ctx);
    const role = await args.resolveRoleArg(ctx, { index: 1 });

    const parsed = args.takeDuration(ctx.args.slice(2));
    if (parsed.durationMs === null) {
      throw new ValidationError('Provide a duration, for example 12h or 7d.');
    }

    const reasonTokens = parsed.rest;
    const reason = reasonTokens.length > 0
      ? args.buildReason(ctx, reasonTokens, { fallback: 'Temporary role' })
      : 'Temporary role';

    const result = await punishmentService.tempRole(ctx, target, role, parsed.durationMs, { reason });
    await ctx.replyEmbed(result.embed);
  },
};
