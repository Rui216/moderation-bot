'use strict';

/** Look up a single moderation case by its case number. */

const { COLORS } = require('../../config/constants');
const { baseEmbed, emptyEmbed } = require('../../utils/embeds');
const { formatAbsolute, formatDuration } = require('../../utils/duration');
const { cleanText } = require('../../utils/sanitize');
const { ValidationError } = require('../../utils/errors');
const { repo } = require('../../db');

module.exports = {
  name: 'case',
  aliases: ['caseinfo', 'viewcase'],
  description: 'Show the full details of a moderation case.',
  usage: 'case <case number>',
  examples: ['case 128'],
  permission: 'moderator',
  action: null,
  slashOptions: [
    { name: 'case_number', type: 'integer', required: true },
  ],

  async execute(ctx) {
    const caseNumber = Number.parseInt(ctx.args[0], 10);
    if (!Number.isFinite(caseNumber) || caseNumber <= 0) {
      throw new ValidationError('Provide a case number, for example: case 128');
    }

    const record = await repo('cases').get(ctx.guild.id, caseNumber);
    if (!record) {
      await ctx.replyEmbed(emptyEmbed('Case Not Found', `No case with the number ${caseNumber} exists in this server.`));
      return;
    }

    const fields = [
      { name: 'Action', value: record.action.replace(/_/g, ' '), inline: true },
      { name: 'Status', value: record.status, inline: true },
    ];

    if (record.targetId) fields.push({ name: 'Target', value: `<@${record.targetId}>\n${record.targetId}`, inline: true });
    fields.push({ name: 'Moderator', value: record.moderatorId === 'system' ? 'Automated system' : `<@${record.moderatorId}>`, inline: true });
    if (record.channelId) fields.push({ name: 'Channel', value: `<#${record.channelId}>`, inline: true });
    if (Number.isFinite(record.durationMs) && record.durationMs > 0) {
      fields.push({ name: 'Duration', value: formatDuration(record.durationMs), inline: true });
    }
    if (Number.isFinite(record.expiresAt)) {
      fields.push({ name: 'Expires', value: formatAbsolute(record.expiresAt), inline: true });
    }
    fields.push({ name: 'Reason', value: cleanText(record.reason, 1000) || 'No reason recorded', inline: false });

    if (record.evidenceUrl) fields.push({ name: 'Evidence', value: record.evidenceUrl, inline: false });

    const metadata = record.metadata || {};
    const detailKeys = Object.keys(metadata).filter((key) => key !== 'attachments').slice(0, 6);
    if (detailKeys.length > 0) {
      fields.push({
        name: 'Recorded Details',
        value: detailKeys.map((key) => `${key}: ${cleanText(JSON.stringify(metadata[key]), 120)}`).join('\n'),
        inline: false,
      });
    }

    if (record.reversedAt) {
      fields.push({
        name: 'Reversed',
        value: `${formatAbsolute(record.reversedAt)}${record.reversedBy ? ` by <@${record.reversedBy}>` : ''}`,
        inline: false,
      });
    }

    await ctx.replyEmbed(baseEmbed({
      title: `Case #${record.caseNumber}`,
      color: record.status === 'active' ? COLORS.info : COLORS.success,
      fields,
      footer: `${ctx.guild.name} | Case #${record.caseNumber}`,
    }));
  },
};
