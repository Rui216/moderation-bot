'use strict';

/** Role details: colour, position, flags, member count, and granted permissions. */

const { COLORS } = require('../../config/constants');
const args = require('../../utils/args');
const { baseEmbed } = require('../../utils/embeds');
const { formatAbsolute } = require('../../utils/duration');

/** Permissions shown by name when a role grants them. Other grants are summarised by count. */
const NOTABLE_PERMISSIONS = new Set([
  'Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageMessages',
  'KickMembers', 'BanMembers', 'ModerateMembers', 'ManageNicknames', 'ManageWebhooks',
  'ManageEmojisAndStickers', 'MentionEveryone', 'ViewAuditLog', 'ManageEvents',
]);

module.exports = {
  name: 'roleinfo',
  aliases: ['role'],
  description: 'Show a role: colour, position, flags, member count, and notable permissions.',
  usage: 'roleinfo <role>',
  examples: ['roleinfo @Moderators', 'roleinfo Moderators'],
  permission: 'everyone',
  action: null,
  slashOptions: [
    { name: 'role', type: 'role', required: true },
  ],

  async execute(ctx) {
    const role = await args.resolveRoleArg(ctx, { index: 0, required: true });
    const granted = role.permissions.toArray();
    const notable = granted.filter((name) => NOTABLE_PERMISSIONS.has(name));
    const others = granted.length - notable.length;

    const memberCount = role.members.size;
    const hex = role.hexColor && role.hexColor !== '#000000' ? role.hexColor : 'default';

    await ctx.replyEmbed(baseEmbed({
      title: `Role: ${role.name}`,
      color: role.color || COLORS.info,
      fields: [
        { name: 'Role ID', value: role.id, inline: true },
        { name: 'Mention', value: `<@&${role.id}>`, inline: true },
        { name: 'Colour', value: hex, inline: true },
        { name: 'Position', value: String(role.position), inline: true },
        { name: 'Members', value: `${memberCount}${role.members.size === 0 ? ' (member cache may be incomplete)' : ''}`, inline: true },
        { name: 'Created', value: formatAbsolute(role.createdTimestamp), inline: true },
        { name: 'Mentionable', value: role.mentionable ? 'yes' : 'no', inline: true },
        { name: 'Shown Separately', value: role.hoist ? 'yes' : 'no', inline: true },
        { name: 'Managed By', value: role.managed ? 'integration or bot' : 'server', inline: true },
        { name: 'Bot Can Edit', value: role.editable ? 'yes' : 'no', inline: true },
        {
          name: 'Notable Permissions',
          value: notable.length > 0 ? notable.join(', ') : 'None of the moderation or admin permissions',
          inline: false,
        },
        ...(others > 0 ? [{ name: 'Other Permissions', value: `${others} more granted`, inline: true }] : []),
      ],
      footer: `${ctx.guild.name} | roleinfo`,
    }));
  },
};
