'use strict';

/**
 * Channel details: type, category, topic, slowmode, permission overrides, the
 * bot's access, and any role the bot uses this channel for.
 */

const { ChannelType } = require('discord.js');
const { COLORS } = require('../../config/constants');
const args = require('../../utils/args');
const { baseEmbed } = require('../../utils/embeds');
const { formatAbsolute } = require('../../utils/duration');
const { cleanText } = require('../../utils/sanitize');
const readinessService = require('../../services/readinessService');
const { readAppeals } = require('../../services/appealService');

/** Log slot labels, matching setup and logconfig wording. */
const LOG_SLOT_LABELS = {
  modLog: 'Mod log',
  messageLog: 'Message log',
  joinLeaveLog: 'Join/leave log',
  voiceLog: 'Voice log',
  serverLog: 'Server log',
  automodLog: 'Automod log',
};

/** Friendly name for a channel type, e.g. "GuildText" becomes "Text". */
function describeType(type) {
  const names = {
    [ChannelType.GuildText]: 'Text',
    [ChannelType.GuildVoice]: 'Voice',
    [ChannelType.GuildCategory]: 'Category',
    [ChannelType.GuildAnnouncement]: 'Announcement',
    [ChannelType.GuildStageVoice]: 'Stage',
    [ChannelType.GuildForum]: 'Forum',
    [ChannelType.PublicThread]: 'Public thread',
    [ChannelType.PrivateThread]: 'Private thread',
    [ChannelType.AnnouncementThread]: 'Announcement thread',
  };
  return names[type] || `Type ${type}`;
}

module.exports = {
  name: 'channelinfo',
  aliases: ['chinfo', 'channel'],
  description: 'Show a channel: type, category, topic, slowmode, overrides, and the bot\'s access.',
  usage: 'channelinfo [channel]',
  examples: ['channelinfo', 'channelinfo #general'],
  permission: 'everyone',
  action: null,
  slashOptions: [
    { name: 'channel', type: 'channel', required: false },
  ],

  async execute(ctx) {
    const channel = (await args.resolveChannelArg(ctx, { index: 0, required: false })) || ctx.channel;
    const guild = ctx.guild;
    const me = guild.members.me || null;
    const access = readinessService.channelAccess(me, channel);

    // Where the bot uses this channel, if anywhere.
    const uses = [];
    const logChannels = (ctx.config.logChannels) || {};
    for (const [slot, label] of Object.entries(LOG_SLOT_LABELS)) {
      if (logChannels[slot] === channel.id) uses.push(label);
    }
    const appeals = readAppeals(ctx.config.misc);
    if (appeals.channelId === channel.id) uses.push('Ban appeals');

    const fields = [
      { name: 'Channel ID', value: channel.id, inline: true },
      { name: 'Mention', value: `<#${channel.id}>`, inline: true },
      { name: 'Type', value: describeType(channel.type), inline: true },
      { name: 'Category', value: channel.parent ? channel.parent.name : 'None', inline: true },
      { name: 'Position', value: String(channel.rawPosition ?? 'n/a'), inline: true },
      { name: 'Created', value: formatAbsolute(channel.createdTimestamp), inline: true },
      { name: 'Permission Overrides', value: String(channel.permissionOverwrites ? channel.permissionOverwrites.cache.size : 0), inline: true },
      {
        name: 'Synced With Category',
        value: channel.parent && typeof channel.permissionsLocked === 'boolean' ? (channel.permissionsLocked ? 'yes' : 'no') : 'n/a',
        inline: true,
      },
    ];

    if (channel.isTextBased && channel.isTextBased() && !channel.isThread?.()) {
      fields.push({ name: 'NSFW', value: channel.nsfw ? 'yes' : 'no', inline: true });
      fields.push({
        name: 'Slowmode',
        value: channel.rateLimitPerUser ? `${channel.rateLimitPerUser} seconds` : 'off',
        inline: true,
      });
      const topic = cleanText(channel.topic || '', 300);
      fields.push({ name: 'Topic', value: topic || 'None', inline: false });
    }

    if (channel.bitrate || channel.userLimit !== undefined) {
      fields.push({ name: 'Bitrate', value: channel.bitrate ? `${Math.round(channel.bitrate / 1000)} kbps` : 'n/a', inline: true });
      fields.push({ name: 'User Limit', value: channel.userLimit ? String(channel.userLimit) : 'unlimited', inline: true });
    }

    fields.push({
      name: 'Bot Access',
      value: access.ok
        ? 'Can view, send messages, and embed here.'
        : `Missing ${access.missing.join(', ')}`,
      inline: false,
    });
    fields.push({
      name: 'Used By The Bot',
      value: uses.length > 0 ? uses.join(', ') : 'Not used as a log or appeals channel',
      inline: false,
    });

    await ctx.replyEmbed(baseEmbed({
      title: `Channel: ${channel.name}`,
      color: access.ok ? COLORS.info : COLORS.notice,
      fields,
      footer: `${guild.name} | channelinfo`,
    }));
  },
};
