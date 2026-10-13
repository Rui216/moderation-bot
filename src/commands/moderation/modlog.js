'use strict';

/**
 * Show a member's moderation history.
 *
 * Two modes:
 *   modlog <member>      case history for that member
 *   modlog <case number> details of that case
 *
 * Pagination is available with --page and filtering with --action.
 */

const { COLORS } = require('../../config/constants');
const args = require('../../utils/args');
const { baseEmbed, emptyEmbed, moderationEmbed } = require('../../utils/embeds');
const { formatAbsolute, humanizeAge } = require('../../utils/duration');
const { cleanText } = require('../../utils/sanitize');
const { ValidationError } = require('../../utils/errors');
const { repo } = require('../../db');

/** Cases shown per page. */
const PAGE_SIZE = 8;

module.exports = {
  name: 'modlog',
  aliases: ['history', 'cases', 'modlogs'],
  description: 'Show moderation history for a member or the details of a single case.',
  usage: 'modlog <member | case number> [--page=2] [--action=ban]',
  examples: ['modlog @User', 'modlog 128', 'modlog @User --page=2'],
  permission: 'moderator',
  action: null,
  slashOptions: [
    { name: 'target', type: 'string', required: true },
  ],

  async execute(ctx) {
    const query = args.requireArg(ctx.args[0], 'Provide a member, user id, or case number.');
    const page = Math.max(1, Number.parseInt(ctx.flags.page, 10) || 1);

    // A pure number is ambiguous: prefer a case lookup only when no member matches.
    if (/^\d+$/.test(query)) {
      const member = await ctx.resolveMember(query);
      if (!member) {
        const record = await repo('cases').get(ctx.guild.id, Number.parseInt(query, 10));
        if (record) {
          await ctx.replyEmbed(buildCaseEmbed(ctx, record));
          return;
        }
        throw new ValidationError(`No member or case matches "${query}" in this server.`);
      }
    }

    const target = await ctx.resolveMember(query);
    if (!target) throw new ValidationError('That member could not be found in this server.');

    const filters = { userId: target.id, page, limit: PAGE_SIZE };
    if (typeof ctx.flags.action === 'string') filters.action = ctx.flags.action.toLowerCase();

    const [history, warnings, strikes, tasks, punishments] = await Promise.all([
      repo('cases').list(ctx.guild.id, filters),
      repo('warnings').count(ctx.guild.id, target.id, true).catch(() => ({ active: 0, total: 0 })),
      repo('punishments').getStrikes(ctx.guild.id, target.id).catch(() => 0),
      repo('tasks').listForUser(ctx.guild.id, target.id).catch(() => []),
      repo('punishments').list(ctx.guild.id, target.id).catch(() => []),
    ]);

    if (history.total === 0) {
      await ctx.replyEmbed(emptyEmbed(
        'No Moderation History',
        `${target.user.tag} has no recorded moderation actions in this server.`,
        COLORS.success,
      ));
      return;
    }

    const lines = history.cases.map((record) => {
      const actor = record.moderatorId === 'system' ? 'Automated system' : `<@${record.moderatorId}>`;
      return [
        `Case #${record.caseNumber} | ${record.action.replace(/_/g, ' ')} | ${record.status}`,
        `Moderator: ${actor} | ${formatAbsolute(record.createdAt)}`,
        `Reason: ${cleanText(record.reason, 160) || 'No reason recorded'}`,
      ].join('\n');
    });

    const fields = [
      { name: 'Active Warnings', value: String(warnings.active), inline: true },
      { name: 'Total Warnings', value: String(warnings.total), inline: true },
      { name: 'Automod Strikes', value: String(strikes), inline: true },
    ];

    if (punishments.length > 0) {
      fields.push({
        name: 'Currently Applied',
        value: punishments
          .map((entry) => `${entry.type}${entry.roleId ? ` (<@&${entry.roleId}>)` : ''}${entry.expiresAt ? ` until ${formatAbsolute(entry.expiresAt)}` : ' (permanent)'}`)
          .join('\n')
          .slice(0, 1024),
        inline: false,
      });
    }

    if (tasks.length > 0) {
      fields.push({
        name: 'Pending Scheduled Actions',
        value: tasks
          .map((task) => `${task.type.replace(/_/g, ' ')} at ${formatAbsolute(task.runAt)}`)
          .join('\n')
          .slice(0, 1024),
        inline: false,
      });
    }

    await ctx.replyEmbed(baseEmbed({
      title: `Moderation History for ${target.user.tag}`,
      description: lines.join('\n\n'),
      color: COLORS.info,
      fields,
      thumbnail: target.displayAvatarURL({ size: 128 }),
      footer: `${ctx.guild.name} | ${history.total} cases | Page ${history.page} of ${history.pages}`,
    }));
  },
};

/** Build the detail embed for a single case (shared with the case command shape). */
function buildCaseEmbed(ctx, record) {
  return moderationEmbed({
    action: record.action,
    target: record.targetId ? `<@${record.targetId}>` : undefined,
    moderator: record.moderatorId === 'system' ? 'Automated system' : `<@${record.moderatorId}>`,
    reason: record.reason || 'No reason recorded',
    caseId: record.caseNumber,
    durationMs: record.durationMs || undefined,
    expiresAtMs: record.expiresAt || undefined,
    description: `Recorded ${humanizeAge(record.createdAt)}. Status: ${record.status}.`,
    footer: `${ctx.guild.name} | Case #${record.caseNumber}`,
  });
}

module.exports.PAGE_SIZE = PAGE_SIZE;
