'use strict';

/**
 * Add a private moderator note about a member.
 *
 * Notes are never shown to the member and never trigger a direct message. They
 * are visible to staff through the notes command and in whois output.
 */

const args = require('../../utils/args');
const punishmentService = require('../../services/punishmentService');

module.exports = {
  name: 'note',
  aliases: ['addnote'],
  description: 'Add a private staff note about a member. The member is not notified.',
  usage: 'note <member> <text>',
  examples: ['note @User Watch for repeated off-topic posting'],
  permission: 'moderator',
  action: null,
  slashOptions: [
    { name: 'member', type: 'member', required: true },
    { name: 'text', type: 'string', required: true },
  ],

  async execute(ctx) {
    const target = await args.resolveMember(ctx);
    const content = args.requireArg(ctx.args.slice(1).join(' ').trim(), 'Provide the note text.');

    const { note, result } = await punishmentService.addNote(ctx, target.id, content);

    await ctx.replyEmbed({
      ...result.embed,
      description: `Private note ${note.id} added for ${target.user.tag}. This is visible to staff only.`,
    });
  },
};
