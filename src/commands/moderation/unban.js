'use strict';

/**
 * Remove a ban. Accepts a user id, which is the only identifier available for
 * people who are no longer in the server.
 */

const args = require('../../utils/args');
const punishmentService = require('../../services/punishmentService');
const { ValidationError } = require('../../utils/errors');

module.exports = {
  name: 'unban',
  aliases: ['ub'],
  description: 'Remove a ban so the user may rejoin.',
  usage: 'unban <user id or mention> <reason>',
  examples: ['unban 123456789012345678 Appeal accepted'],
  permission: 'moderator',
  action: 'unban',
  slashOptions: [
    { name: 'user', type: 'string', required: true },
    { name: 'reason', type: 'string', required: false },
  ],

  async execute(ctx) {
    const query = args.requireArg(ctx.args[0], 'Provide the user to unban. A raw user id works best.');

    // Resolve from the ban list first: that guarantees the id belongs to a
    // banned user even when they are not cached locally.
    let user = null;
    const banList = await ctx.guild.bans.fetch({ limit: 1000 }).catch(() => null);
    const idMatch = /^\d{17,20}$/.test(query) ? query : (parser_mentionId(query) || null);

    if (banList && idMatch) {
      const entry = banList.get(idMatch);
      if (entry) user = entry.user;
    }

    if (!user) {
      user = await ctx.resolveUser(query);
    }

    if (!user) {
      throw new ValidationError('That user could not be resolved. Copy their user id from the ban list and try again.');
    }

    const reason = args.buildReason(ctx, ctx.args.slice(1));

    const result = await punishmentService.unban(ctx, user, { reason });
    await ctx.replyEmbed(result.embed);
  },
};

/** Extract an id from a user mention. */
function parser_mentionId(value) {
  const match = /^<@!?(\d{17,20})>$/.exec(String(value || '').trim());
  return match ? match[1] : null;
}
