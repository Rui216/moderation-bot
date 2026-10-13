'use strict';

/** Remove a private staff note by its id. */

const { COLORS } = require('../../config/constants');
const { successEmbed } = require('../../utils/embeds');
const { ValidationError } = require('../../utils/errors');
const { repo } = require('../../db');

module.exports = {
  name: 'delnote',
  aliases: ['removenote'],
  description: 'Remove a private staff note by its id.',
  usage: 'delnote <note id>',
  examples: ['delnote 12'],
  permission: 'moderator',
  action: null,
  slashOptions: [
    { name: 'note_id', type: 'string', required: true },
  ],

  async execute(ctx) {
    const noteId = Number.parseInt(ctx.args[0], 10);
    if (!Number.isFinite(noteId) || noteId <= 0) {
      throw new ValidationError('Provide the numeric note id. Use the notes command to find it.');
    }

    const note = await repo('notes').remove(ctx.guild.id, noteId);
    if (!note) throw new ValidationError('No note with that id exists in this server.');

    await ctx.replyEmbed(successEmbed({
      title: 'Note Removed',
      color: COLORS.success,
      description: `Note ${noteId} for <@${note.userId}> has been removed.`,
      fields: [
        { name: 'Removed By', value: `<@${ctx.author.id}>`, inline: true },
        { name: 'Note Author', value: `<@${note.authorId}>`, inline: true },
      ],
      footer: ctx.guild.name,
    }));
  },
};
