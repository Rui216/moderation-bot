'use strict';

/** List private staff notes about a member. */

const { COLORS } = require('../../config/constants');
const args = require('../../utils/args');
const { baseEmbed, emptyEmbed } = require('../../utils/embeds');
const { formatAbsolute } = require('../../utils/duration');
const { cleanText } = require('../../utils/sanitize');
const { repo } = require('../../db');

module.exports = {
  name: 'notes',
  aliases: ['listnotes'],
  description: 'List private staff notes for a member.',
  usage: 'notes <member>',
  examples: ['notes @User'],
  permission: 'moderator',
  action: null,
  slashOptions: [
    { name: 'member', type: 'member', required: true },
  ],

  async execute(ctx) {
    const target = await args.resolveMember(ctx);
    const notes = await repo('notes').list(ctx.guild.id, target.id);

    if (notes.length === 0) {
      await ctx.replyEmbed(emptyEmbed('No Notes', `There are no staff notes for ${target.user.tag}.`, COLORS.info));
      return;
    }

    const lines = notes.slice(0, 10).map((note) => [
      `Note ${note.id} | ${formatAbsolute(note.createdAt)}`,
      `Author: <@${note.authorId}>${note.caseNumber ? ` | Case #${note.caseNumber}` : ''}`,
      cleanText(note.content, 300),
    ].join('\n'));

    await ctx.replyEmbed(baseEmbed({
      title: `Staff Notes for ${target.user.tag}`,
      color: COLORS.info,
      description: lines.join('\n\n'),
      fields: [{ name: 'Total Notes', value: String(notes.length), inline: true }],
      thumbnail: target.displayAvatarURL({ size: 128 }),
      footer: `${ctx.guild.name} | Staff only`,
    }));
  },
};
