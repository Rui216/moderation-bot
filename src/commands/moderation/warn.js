'use strict';

/**
 * Warn a member.
 *
 * A warning is stored twice on purpose: as a case (permanent history) and as a
 * warning row (clearable, optionally expiring). The reply shows the member's
 * current warning count so the escalation is visible to the moderator.
 */

const { COLORS } = require('../../config/constants');
const args = require('../../utils/args');
const { moderationEmbed } = require('../../utils/embeds');
const punishmentService = require('../../services/punishmentService');

module.exports = {
  name: 'warn',
  aliases: ['w'],
  description: 'Warn a member and record the warning on their history.',
  usage: 'warn <member> <reason>',
  examples: ['warn @User Posting off-topic content in announcements'],
  permission: 'moderator',
  action: 'warn',
  slashOptions: [
    { name: 'member', type: 'member', required: true },
    { name: 'reason', type: 'string', required: false },
  ],

  async execute(ctx) {
    const target = await args.resolveMember(ctx);
    const reason = args.buildReason(ctx, ctx.args.slice(1));

    const expiresInDays = Number.isFinite(Number(ctx.flags.expires)) ? Math.max(0, Number(ctx.flags.expires)) : 0;

    const result = await punishmentService.warn(ctx, target, {
      reason,
      evidenceUrl: ctx.flags.evidence || null,
      warningExpiresDays: expiresInDays,
    });

    const counts = result.warningCounts || { active: 0, total: 0 };

    const embed = moderationEmbed({
      action: 'warn',
      target,
      moderator: ctx.moderator,
      reason,
      caseId: result.caseNumber,
      extraFields: [
        { name: 'Active Warnings', value: String(counts.active), inline: true },
        { name: 'Total Warnings', value: String(counts.total), inline: true },
        ...(expiresInDays > 0 ? [{ name: 'Warning Expires', value: `After ${expiresInDays} days`, inline: true }] : []),
        ...(result.dmDelivered === false ? [{ name: 'Direct Message', value: 'Not delivered (DMs closed)', inline: true }] : []),
      ],
      footer: `${ctx.guild.name} | Case #${result.caseNumber}`,
      color: COLORS.warn,
    });

    await ctx.replyEmbed(embed);
  },
};
