'use strict';

/**
 * Member profile: account age, join date, roles, warning count, moderation
 * cases, active punishments, pending scheduled actions, and staff notes.
 *
 * Staff notes are included only when the caller holds a moderator role or
 * higher, so private notes never leak to regular members.
 */

const { COLORS } = require('../../config/constants');
const args = require('../../utils/args');
const { baseEmbed } = require('../../utils/embeds');
const { formatAbsolute, humanizeAge } = require('../../utils/duration');
const { cleanText } = require('../../utils/sanitize');
const { repo } = require('../../db');
const permissionService = require('../../services/permissionService');

module.exports = {
  name: 'whois',
  aliases: ['userinfo', 'profile'],
  description: 'Show account details, roles, and moderation summary for a member.',
  usage: 'whois [member]',
  examples: ['whois @User', 'whois'],
  permission: 'everyone',
  action: null,
  slashOptions: [
    { name: 'member', type: 'member', required: false },
  ],

  async execute(ctx) {
    const target = ctx.args[0]
      ? await args.resolveMember(ctx)
      : ctx.member;

    const isStaff = permissionService.isStaff(ctx.member, ctx.config, ctx.appConfig.discord.ownerIds);

    const [warnings, history, punishments, tasks, notes] = await Promise.all([
      repo('warnings').count(ctx.guild.id, target.id, true).catch(() => ({ active: 0, total: 0 })),
      repo('cases').list(ctx.guild.id, { userId: target.id, limit: 5 }).catch(() => ({ cases: [], total: 0 })),
      repo('punishments').list(ctx.guild.id, target.id).catch(() => []),
      repo('tasks').listForUser(ctx.guild.id, target.id).catch(() => []),
      isStaff ? repo('notes').list(ctx.guild.id, target.id).catch(() => []) : Promise.resolve([]),
    ]);

    const roles = target.roles.cache
      .filter((role) => role.id !== ctx.guild.id)
      .sort((a, b) => b.position - a.position)
      .map((role) => `<@&${role.id}>`)
      .slice(0, 20);

    const fields = [
      { name: 'Account Created', value: `${formatAbsolute(target.user.createdTimestamp)}\n${humanizeAge(target.user.createdTimestamp)}`, inline: true },
      { name: 'Joined Server', value: target.joinedTimestamp ? `${formatAbsolute(target.joinedTimestamp)}\n${humanizeAge(target.joinedTimestamp)}` : 'Not a member', inline: true },
      { name: 'Member ID', value: target.id, inline: true },
      { name: 'Display Name', value: cleanText(target.displayName, 100) || target.user.username, inline: true },
      { name: 'Bot Account', value: target.user.bot ? 'Yes' : 'No', inline: true },
      { name: 'Level', value: permissionService.levelLabel(permissionService.resolveLevel(target, ctx.config, ctx.appConfig.discord.ownerIds).level), inline: true },
      { name: 'Roles', value: roles.join(', ') || 'None', inline: false },
      { name: 'Warnings', value: `Active: ${warnings.active} | Total: ${warnings.total}`, inline: true },
      { name: 'Cases', value: String(history.total), inline: true },
    ];

    if (target.communicationDisabledUntilTimestamp && target.communicationDisabledUntilTimestamp > Date.now()) {
      fields.push({ name: 'Muted Until', value: formatAbsolute(target.communicationDisabledUntilTimestamp), inline: true });
    }

    if (punishments.length > 0) {
      fields.push({
        name: 'Applied Punishments',
        value: punishments
          .map((entry) => `${entry.type}${entry.expiresAt ? ` until ${formatAbsolute(entry.expiresAt)}` : ' (permanent)'}`)
          .join('\n'),
        inline: false,
      });
    }

    if (tasks.length > 0) {
      fields.push({
        name: 'Pending Actions',
        value: tasks.map((task) => `${task.type.replace(/_/g, ' ')} at ${formatAbsolute(task.runAt)}`).join('\n'),
        inline: false,
      });
    }

    if (history.cases.length > 0) {
      fields.push({
        name: 'Recent Cases',
        value: history.cases
          .map((record) => `#${record.caseNumber} ${record.action.replace(/_/g, ' ')} - ${cleanText(record.reason, 80) || 'no reason'}`)
          .join('\n'),
        inline: false,
      });
    }

    if (isStaff) {
      fields.push({
        name: 'Staff Notes',
        value: notes.length > 0
          ? notes.slice(0, 5).map((note) => `Note ${note.id}: ${cleanText(note.content, 140)}`).join('\n')
          : 'None',
        inline: false,
      });
    }

    await ctx.replyEmbed(baseEmbed({
      title: `Profile: ${target.user.tag}`,
      color: COLORS.info,
      thumbnail: target.displayAvatarURL({ size: 256 }),
      fields,
      footer: `${ctx.guild.name} | Requested by ${ctx.author.username}`,
    }));
  },
};
