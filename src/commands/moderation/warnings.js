'use strict';

/**
 * List a member's warnings, active by default, with their case references.
 */

const { COLORS } = require('../../config/constants');
const args = require('../../utils/args');
const { baseEmbed, emptyEmbed } = require('../../utils/embeds');
const { formatDuration, formatAbsolute } = require('../../utils/duration');
const { cleanText } = require('../../utils/sanitize');
const { repo } = require('../../db');

/** Warnings displayed per page. */
const PAGE_SIZE = 8;

module.exports = {
  name: 'warnings',
  aliases: ['warns', 'infractions'],
  description: 'List warnings for a member. Use --all to include cleared and expired warnings.',
  usage: 'warnings <member> [--all] [--page=2]',
  examples: ['warnings @User', 'warnings @User --all'],
  permission: 'moderator',
  action: null,
  slashOptions: [
    { name: 'member', type: 'member', required: true },
  ],

  async execute(ctx) {
    const target = await args.resolveMember(ctx);
    const includeInactive = Boolean(ctx.flags.all);
    const page = Math.max(1, Number.parseInt(ctx.flags.page, 10) || 1);

    const [warnings, counts] = await Promise.all([
      repo('warnings').list(ctx.guild.id, target.id, { activeOnly: !includeInactive }),
      repo('warnings').count(ctx.guild.id, target.id, true),
    ]);

    if (warnings.length === 0) {
      await ctx.replyEmbed(emptyEmbed(
        includeInactive ? 'No Warnings Recorded' : 'No Active Warnings',
        `${target.user.tag} has ${includeInactive ? 'no warnings on record' : 'no active warnings'}.`,
        COLORS.success,
      ));
      return;
    }

    const pages = Math.max(1, Math.ceil(warnings.length / PAGE_SIZE));
    const current = Math.min(page, pages);
    const slice = warnings.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

    const lines = slice.map((warning) => {
      const status = warning.active ? 'Active' : 'Cleared or expired';
      const expiry = warning.expiresAt
        ? ` | expires ${formatAbsolute(warning.expiresAt)}`
        : '';
      const moderator = ctx.guild.client.users.cache.get(warning.moderatorId);
      const moderatorLabel = moderator ? moderator.tag : warning.moderatorId;
      return [
        `Warning ${warning.id} | ${status}${expiry}`,
        `Case: ${warning.caseNumber ? `#${warning.caseNumber}` : 'none'} | Moderator: ${moderatorLabel}`,
        `Reason: ${cleanText(warning.reason, 200) || 'No reason recorded'}`,
        `Issued: ${formatAbsolute(warning.createdAt)}`,
      ].join('\n');
    });

    const embed = baseEmbed({
      title: `Warnings for ${target.user.tag}`,
      color: COLORS.warn,
      description: lines.join('\n\n'),
      fields: [
        { name: 'Active', value: String(counts.active), inline: true },
        { name: 'Total', value: String(counts.total), inline: true },
        ...(target.communicationDisabledUntilTimestamp
          ? [{ name: 'Muted Until', value: formatAbsolute(target.communicationDisabledUntilTimestamp), inline: true }]
          : []),
      ],
      thumbnail: target.displayAvatarURL({ size: 128 }),
      footer: `${ctx.guild.name} | Page ${current} of ${pages}`,
    });

    await ctx.replyEmbed(embed);
  },
};

/** Exported for reuse in tests. */
module.exports.PAGE_SIZE = PAGE_SIZE;
