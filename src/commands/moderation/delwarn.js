'use strict';

/**
 * Remove a single warning by its warning id. The removal is itself recorded as
 * a case, so the history shows who cleared what.
 */

const args = require('../../utils/args');
const punishmentService = require('../../services/punishmentService');
const { ValidationError } = require('../../utils/errors');

module.exports = {
  name: 'delwarn',
  aliases: ['removewarn', 'unwarn'],
  description: 'Remove a warning from a member history by its warning id.',
  usage: 'delwarn <warning id> <reason>',
  examples: ['delwarn 42 Warning issued in error'],
  permission: 'moderator',
  action: 'warn',
  slashOptions: [
    { name: 'warning_id', type: 'string', required: true },
    { name: 'reason', type: 'string', required: false },
  ],

  async execute(ctx) {
    const warningId = Number.parseInt(ctx.args[0], 10);
    if (!Number.isFinite(warningId) || warningId <= 0) {
      throw new ValidationError('Provide the numeric warning id. Use the warnings command to find it.');
    }

    const reason = ctx.args.length > 1 ? args.buildReason(ctx, ctx.args.slice(1), { fallback: 'Warning removed' }) : 'Warning removed';

    const { warning, record } = await punishmentService.removeWarning(ctx, warningId, reason);

    await ctx.replyEmbed({
      ...record.embed,
      description: `Warning ${warningId} was removed from <@${warning.userId}>.`,
    });
  },
};
