'use strict';

/**
 * Remove a role from a member.
 *
 * Removing a role also clears any temporary role record and cancels the pending
 * expiry task, so the member is not processed twice later.
 */

const args = require('../../utils/args');
const punishmentService = require('../../services/punishmentService');

module.exports = {
  name: 'removerole',
  aliases: ['takerole', 'delrole'],
  description: 'Remove a role from a member.',
  usage: 'removerole <member> <role> [reason]',
  examples: ['removerole @User @Verified No longer verified'],
  permission: 'moderator',
  action: 'removerole',
  slashOptions: [
    { name: 'member', type: 'member', required: true },
    { name: 'role', type: 'role', required: true },
    { name: 'reason', type: 'string', required: false },
  ],

  async execute(ctx) {
    const target = await args.resolveMember(ctx);
    const role = await args.resolveRoleArg(ctx, { index: 1 });

    const reasonTokens = ctx.args.slice(2);
    const reason = reasonTokens.length > 0
      ? args.buildReason(ctx, reasonTokens, { fallback: 'Role removed' })
      : 'Role removed';

    const result = await punishmentService.removeRole(ctx, target, role, { reason });
    await ctx.replyEmbed(result.embed);
  },
};
