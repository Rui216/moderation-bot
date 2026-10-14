'use strict';

/** Configure the ticket category, support role, and optional log channel. */

const { ChannelType } = require('discord.js');
const { COLORS } = require('../../config/constants');
const { baseEmbed } = require('../../utils/embeds');
const { ValidationError } = require('../../utils/errors');
const ticketService = require('../../services/ticketService');
const { repo } = require('../../db');

const CHANNEL_MENTION = /^<#(\d{17,20})>$/;
const ROLE_MENTION = /^<@&(\d{17,20})>$/;

module.exports = {
  name: 'ticketsetup',
  aliases: ['ticketconfig'],
  description: 'Set the ticket category, support role, and transcript log channel.',
  usage: 'ticketsetup [category] [support role] [log channel]',
  examples: ['ticketsetup #tickets @Support #ticket-log', 'ticketsetup'],
  permission: 'admin',
  action: null,
  slashOptions: [
    { name: 'category', type: 'channel', required: false, description: 'Category that holds ticket channels' },
    { name: 'support_role', type: 'role', required: false, description: 'Role that can read and answer tickets' },
    { name: 'log_channel', type: 'channel', required: false, description: 'Channel that receives transcripts' },
  ],

  async execute(ctx) {
    const tokens = ctx.args.filter((token) => token && token.trim());
    const channelIds = tokens.map((t) => (t.match(CHANNEL_MENTION) || [])[1]).filter(Boolean);
    const roleIds = tokens.map((t) => (t.match(ROLE_MENTION) || [])[1]).filter(Boolean);

    if (channelIds.length === 0 && roleIds.length === 0) {
      const config = await repo('guilds').getConfig(ctx.guild.id, { force: true });
      const settings = ticketService.readSettings(config.misc);
      await ctx.replyEmbed(baseEmbed({
        title: 'Ticket Settings',
        color: COLORS.info,
        fields: [
          { name: 'Category', value: settings.categoryId ? `<#${settings.categoryId}>` : 'Not set', inline: true },
          { name: 'Support Role', value: settings.supportRoleId ? `<@&${settings.supportRoleId}>` : 'Not set', inline: true },
          { name: 'Log Channel', value: settings.logChannelId ? `<#${settings.logChannelId}>` : 'Not set', inline: true },
          { name: 'Open Tickets', value: String(Object.keys(settings.open).length), inline: true },
        ],
        footer: ctx.guild.name,
      }));
      return;
    }

    const values = {};

    if (channelIds.length > 0) {
      const category = await ctx.guild.channels.fetch(channelIds[0]).catch(() => null);
      if (!category || category.type !== ChannelType.GuildCategory) {
        throw new ValidationError('The first channel must be a category, which holds the ticket channels.');
      }
      values.categoryId = category.id;
    }

    if (roleIds.length > 0) {
      const role = ctx.guild.roles.cache.get(roleIds[0]) || await ctx.guild.roles.fetch(roleIds[0]).catch(() => null);
      if (!role) throw new ValidationError('That support role could not be found.');
      values.supportRoleId = role.id;
    }

    if (channelIds.length > 1) {
      const logChannel = await ctx.guild.channels.fetch(channelIds[1]).catch(() => null);
      if (!logChannel || !logChannel.isTextBased()) {
        throw new ValidationError('The log channel must be a text channel.');
      }
      values.logChannelId = logChannel.id;
    }

    const saved = await ticketService.saveSetup(ctx.guild.id, values);

    await ctx.replyEmbed(baseEmbed({
      title: 'Ticket Settings Saved',
      color: COLORS.success,
      fields: [
        { name: 'Category', value: saved.categoryId ? `<#${saved.categoryId}>` : 'Not set', inline: true },
        { name: 'Support Role', value: saved.supportRoleId ? `<@&${saved.supportRoleId}>` : 'Not set', inline: true },
        { name: 'Log Channel', value: saved.logChannelId ? `<#${saved.logChannelId}>` : 'Not set', inline: true },
      ],
      footer: ctx.guild.name,
    }));
  },
};
