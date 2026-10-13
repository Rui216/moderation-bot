'use strict';

/**
 * Purge messages from the current channel.
 *
 * Filters are optional and combinable:
 *   purge 50                     remove the last 50 messages
 *   purge 50 --user=@User        only messages from that member
 *   purge 50 --match=word        only messages containing that text
 *   purge 50 --bots              only messages from bots
 *   purge 50 --humans            only messages from humans
 */

const { COLORS } = require('../../config/constants');
const args = require('../../utils/args');
const { baseEmbed } = require('../../utils/embeds');
const { ValidationError } = require('../../utils/errors');
const { formatDuration } = require('../../utils/duration');
const channelService = require('../../services/channelService');

module.exports = {
  name: 'purge',
  aliases: ['clear', 'prune'],
  description: 'Delete recent messages in this channel, optionally filtered by author or content.',
  usage: 'purge <amount> [--user=@User] [--match=text] [--bots] [--humans] [reason]',
  examples: ['purge 50', 'purge 25 --user=@User Spam cleanup', 'purge 100 --match=discord.gg Invite spam'],
  permission: 'moderator',
  action: 'purge',
  slashOptions: [
    { name: 'amount', type: 'integer', required: true },
    { name: 'reason', type: 'string', required: false },
  ],

  async execute(ctx) {
    const amount = Number.parseInt(ctx.args[0], 10);
    if (!Number.isFinite(amount) || amount < 1) {
      throw new ValidationError(`Provide a number of messages to remove (1 to ${ctx.limits.maxPurgeCount}).`);
    }
    if (amount > ctx.limits.maxPurgeCount) {
      throw new ValidationError(`The maximum number of messages per purge is ${ctx.limits.maxPurgeCount}.`);
    }

    let userId = null;
    if (typeof ctx.flags.user === 'string') {
      const member = await ctx.resolveMember(ctx.flags.user);
      if (!member) throw new ValidationError('The member in --user could not be found in this server.');
      userId = member.id;
    }

    const match = typeof ctx.flags.match === 'string' ? ctx.flags.match : null;
    const botsOnly = Boolean(ctx.flags.bots);
    const humansOnly = Boolean(ctx.flags.humans);

    // Everything that is not a flag is treated as the reason.
    const reasonTokens = ctx.args.slice(1).filter((token) => !token.startsWith('--'));
    const reason = reasonTokens.length > 0
      ? args.buildReason(ctx, reasonTokens, { fallback: 'Bulk message removal' })
      : 'Bulk message removal';

    const result = await channelService.purge(ctx, ctx.channel, {
      amount,
      userId,
      match,
      botsOnly,
      humansOnly,
      reason,
    });

    ctx.rawReason = reason;

    await ctx.replyEmbed(baseEmbed({
      title: 'Messages Purged',
      color: COLORS.info,
      description: result.deleted === 0
        ? 'No messages matched those filters in the recent history. Discord cannot bulk delete messages older than 14 days.'
        : `${result.deleted} message${result.deleted === 1 ? '' : 's'} removed from this channel.`,
      fields: [
        { name: 'Channel', value: `<#${ctx.channel.id}>`, inline: true },
        { name: 'Removed', value: String(result.deleted), inline: true },
        { name: 'Scanned', value: String(result.scanned), inline: true },
        ...(userId ? [{ name: 'Author Filter', value: `<@${userId}>`, inline: true }] : []),
        ...(match ? [{ name: 'Content Filter', value: match.slice(0, 200), inline: true }] : []),
        ...(botsOnly ? [{ name: 'Authors', value: 'Bots only', inline: true }] : []),
        ...(humansOnly ? [{ name: 'Authors', value: 'Humans only', inline: true }] : []),
        { name: 'Note', value: `Messages older than ${formatDuration(channelService.BULK_DELETE_MAX_AGE_MS)} are removed individually and limited to 50 per run.`, inline: false },
      ],
      footer: `${ctx.guild.name} | Case #${result.caseNumber || 'pending'}`,
    }));
  },
};
