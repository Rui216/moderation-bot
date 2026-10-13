'use strict';

/**
 * Export the moderation log as a JSON attachment for archival or external
 * review. Admin only, and bounded in size so the bot cannot be asked to build
 * an enormous attachment.
 */

const { AttachmentBuilder } = require('discord.js');

const { COLORS } = require('../../config/constants');
const { baseEmbed, errorEmbed } = require('../../utils/embeds');
const { logger } = require('../../utils/logger');
const { repo } = require('../../db');

const log = logger.child('export');

/** Upper bound on exported cases per invocation. */
const MAX_EXPORT = 5000;
const DEFAULT_EXPORT = 500;

module.exports = {
  name: 'export',
  aliases: ['backup', 'exportmodlog'],
  description: 'Export moderation cases as a JSON file. Administrator only.',
  usage: 'export [amount]',
  examples: ['export', 'export 2000'],
  permission: 'admin',
  action: 'viewcases',
  slashOptions: [
    { name: 'amount', type: 'integer', required: false },
  ],

  async execute(ctx) {
    const requested = Number.parseInt(ctx.args[0], 10);
    const limit = Number.isFinite(requested)
      ? Math.max(1, Math.min(requested, MAX_EXPORT))
      : DEFAULT_EXPORT;

    const [cases, stats] = await Promise.all([
      repo('cases').exportAll(ctx.guild.id, limit),
      repo('guilds').getStats(ctx.guild.id).catch(() => null),
    ]);

    if (cases.length === 0) {
      await ctx.replyEmbed(errorEmbed({
        title: 'Nothing to Export',
        description: 'No moderation cases are stored for this server yet.',
      }));
      return;
    }

    // The export contains moderation records only. No tokens, no configuration
    // secrets, and no internal infrastructure identifiers are included.
    const payload = {
      generatedAt: new Date().toISOString(),
      guild: { id: ctx.guild.id, name: ctx.guild.name },
      summary: {
        exported: cases.length,
        storedCases: stats ? stats.cases : null,
        activeWarnings: stats ? stats.activeWarnings : null,
      },
      cases,
    };

    const buffer = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
    const fileName = `modlog-export-${ctx.guild.id}-${new Date().toISOString().slice(0, 10)}.json`;
    const attachment = new AttachmentBuilder(buffer, { name: fileName });

    log.info('Moderation log exported', { guildId: ctx.guild.id, count: cases.length, requestedBy: ctx.author.id });

    await ctx.replyEmbeds([
      baseEmbed({
        title: 'Moderation Log Exported',
        color: COLORS.success,
        description: `${cases.length} case${cases.length === 1 ? '' : 's'} exported. The file is attached to this message.`,
        fields: [
          { name: 'Exported By', value: `<@${ctx.author.id}>`, inline: true },
          { name: 'Cases', value: String(cases.length), inline: true },
          { name: 'File Size', value: `${Math.max(1, Math.round(buffer.length / 1024))} KB`, inline: true },
        ],
        footer: ctx.guild.name,
      }),
    ]);

    // Attachments are sent separately so the embed stays inside the standard
    // reply shape used everywhere else.
    if (!ctx.isSlash) {
      await ctx.channel.send({ files: [attachment] }).catch(() => null);
    } else {
      await ctx.interaction.followUp({ files: [attachment], ephemeral: true }).catch(() => null);
    }
  },
};
