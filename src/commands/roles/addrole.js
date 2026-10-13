'use strict';

/** Add a role to a member. */

const args = require('../../utils/args');
const punishmentService = require('../../services/punishmentService');

module.exports = {
  name: 'addrole',
  aliases: ['giverole'],
  description: 'Add a role to a member.',
  usage: 'addrole <member> <role> [reason]',
  examples: ['addrole @User @Verified Manual verification'],
  permission: 'moderator',
  action: 'addrole',
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
      ? args.buildReason(ctx, reasonTokens, { fallback: 'Role added' })
      : 'Role added';

    const result = await punishmentService.addRole(ctx, target, role, { reason });
    await ctx.replyEmbed(result.embed);
  },
};
