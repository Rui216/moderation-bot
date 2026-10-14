'use strict';

const { randomBytes } = require('crypto');
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const tickets = require('../services/ticketService');
const permissions = require('../services/permissionService');
const { repo } = require('../db');
const { baseEmbed, errorEmbed, successEmbed } = require('../utils/embeds');
const { ValidationError } = require('../utils/errors');
const { logger } = require('../utils/logger');
const { COLORS } = require('../config/constants');
const log = logger.child('ticket-setup');
const sessions = new Map();
const TTL_MS = 10 * 60 * 1000;
const row = (component) => new ActionRowBuilder().addComponents(component);

function destroy(id) {
  const session = sessions.get(id);
  if (session) clearTimeout(session.timer);
  sessions.delete(id);
}

function render(session) {
  const { draft: d, id, guild } = session;
  const channelSelect = (field, placeholder, types) => {
    const select = new ChannelSelectMenuBuilder().setCustomId(`ticketsetup:${id}:${field}`)
      .setPlaceholder(placeholder).setChannelTypes(types).setMinValues(1).setMaxValues(1);
    if (d[field]) select.setDefaultChannels(d[field]);
    return row(select);
  };
  const role = new RoleSelectMenuBuilder().setCustomId(`ticketsetup:${id}:supportRoleId`)
    .setPlaceholder('2 · Choose the support staff role').setMinValues(1).setMaxValues(1);
  if (d.supportRoleId) role.setDefaultRoles(d.supportRoleId);
  const complete = Boolean(d.categoryId && d.supportRoleId && d.logChannelId);
  const button = (action, label, style, disabled = false) => new ButtonBuilder()
    .setCustomId(`ticketsetup:${id}:${action}`).setLabel(label).setStyle(style).setDisabled(disabled);
  return {
    embeds: [baseEmbed({ title: 'Ticket Setup · Configure & Preview', color: COLORS.info,
      description: 'Choose your destinations below. Changes stay in this draft until you save. Only you can use these controls; this session expires after 10 minutes.\n\nUse a private staff channel for transcripts. Server administrators can always see private tickets.',
      fields: [
        { name: 'Ticket category', value: d.categoryId ? `<#${d.categoryId}>` : 'Not selected', inline: true },
        { name: 'Support role', value: d.supportRoleId ? `<@&${d.supportRoleId}>` : 'Not selected', inline: true },
        { name: 'Transcript log', value: d.logChannelId ? `<#${d.logChannelId}>` : 'Not selected', inline: true },
        { name: 'Panel channel', value: d.panelChannelId ? `<#${d.panelChannelId}>` : 'Not selected', inline: true },
        { name: 'Panel title', value: d.panelTitle, inline: false },
        { name: 'Existing tickets', value: `${Object.keys(d.open).length} open · saving does not reset the ticket counter or remove tickets.`, inline: false },
      ], footer: guild.name })],
    components: [
      channelSelect('categoryId', '1 · Choose the ticket category', [ChannelType.GuildCategory]),
      row(role),
      channelSelect('logChannelId', '3 · Choose the transcript log channel', [ChannelType.GuildText, ChannelType.GuildAnnouncement]),
      channelSelect('panelChannelId', '4 · Choose where to publish the panel', [ChannelType.GuildText, ChannelType.GuildAnnouncement]),
      new ActionRowBuilder().addComponents(
        button('text', 'Edit panel text', ButtonStyle.Secondary),
        button('preview', 'Preview', ButtonStyle.Secondary),
        button('save', 'Save only', ButtonStyle.Success, !complete),
        button('publish', 'Save & publish', ButtonStyle.Primary, !complete || !d.panelChannelId),
        button('cancel', 'Cancel', ButtonStyle.Danger),
      ),
    ], allowedMentions: { parse: [] },
  };
}

async function start(ctx) {
  const config = await repo('guilds').getConfig(ctx.guild.id, { force: true });
  for (const old of sessions.values()) {
    if (old.guild.id === ctx.guild.id && old.userId === ctx.author.id) {
      destroy(old.id);
      await old.edit({ embeds: [baseEmbed({ title: 'Setup Replaced', description: 'Use your newest ticket setup session.' })], components: [] }).catch(() => null);
    }
  }
  const id = randomBytes(8).toString('hex');
  const session = { id, guild: ctx.guild, userId: ctx.author.id, draft: tickets.readSettings(config.misc),
    ownerIds: ctx.appConfig?.discord?.ownerIds || [], expiresAt: Date.now() + TTL_MS, busy: false };
  if (!session.draft.panelChannelId && ctx.channel?.type === ChannelType.GuildText) session.draft.panelChannelId = ctx.channel.id;
  const payload = render(session);
  if (ctx.isSlash) {
    if (!ctx.interaction.deferred && !ctx.interaction.replied) await ctx.interaction.deferReply({ ephemeral: true });
    const sent = await ctx.interaction.editReply(payload);
    session.messageId = sent.id;
    session.edit = (body) => ctx.interaction.editReply(body);
  } else {
    const sent = await ctx.channel.send(payload);
    session.messageId = sent.id;
    session.edit = (body) => sent.edit(body);
  }
  sessions.set(id, session);
  session.timer = setTimeout(() => {
    destroy(id);
    void session.edit({ embeds: [baseEmbed({ title: 'Ticket Setup Expired', description: 'Nothing further was saved. Run ticketsetup again.' })], components: [] }).catch(() => null);
  }, TTL_MS);
  session.timer.unref?.();
  return session;
}

async function handleComponent(client, interaction) {
  if (!interaction.customId?.startsWith('ticketsetup:')) return false;
  const [, id, action] = interaction.customId.split(':');
  const session = sessions.get(id);
  const refuse = (description) => interaction.reply({ embeds: [errorEmbed({ title: 'Ticket Setup', description })], ephemeral: true });
  if (!session || session.expiresAt <= Date.now()) {
    if (session) destroy(id);
    await refuse('This setup has expired or the bot restarted. Run ticketsetup again.');
    return true;
  }
  if (interaction.guildId !== session.guild.id || interaction.user.id !== session.userId
    || (interaction.message && interaction.message.id !== session.messageId)) {
    await refuse('Only the administrator who started this setup can use it.');
    return true;
  }
  if (session.busy) {
    await refuse('The previous change is still being processed. Please try again in a moment.');
    return true;
  }
  session.busy = true;
  try {
    if (action === 'text') {
      // Modal must be the initial response. Authorization is rechecked on submission/save.
      await interaction.showModal(new ModalBuilder().setCustomId(`ticketsetup:${id}:text-submit`).setTitle('Ticket panel text').addComponents(
        row(new TextInputBuilder().setCustomId('title').setLabel('Panel title').setStyle(TextInputStyle.Short)
          .setMaxLength(100).setRequired(true).setValue(session.draft.panelTitle)),
        row(new TextInputBuilder().setCustomId('description').setLabel('Panel description').setStyle(TextInputStyle.Paragraph)
          .setMaxLength(2000).setRequired(true).setValue(session.draft.panelDescription)),
      ));
      return true;
    }
    await interaction.deferUpdate();
    const config = await repo('guilds').getConfig(session.guild.id, { force: true });
    const member = await session.guild.members.fetch(session.userId);
    if (!permissions.canRunCommand({ member, config, command: { permission: 'admin' }, ownerIds: session.ownerIds }).allowed) {
      throw new ValidationError('You no longer have administrator access to bot configuration.');
    }
    if (action === 'cancel') {
      destroy(id);
      await interaction.editReply({ embeds: [baseEmbed({ title: 'Ticket Setup Cancelled', description: 'No draft changes were saved.' })], components: [] });
      return true;
    }
    if (action === 'preview') {
      await interaction.followUp({ embeds: [tickets.panelEmbed(session.guild, session.draft)], ephemeral: true, allowedMentions: { parse: [] } });
      return true;
    }
    if (action === 'text-submit') {
      const title = interaction.fields.getTextInputValue('title').trim();
      const description = interaction.fields.getTextInputValue('description').trim();
      if (!title || title.length > 100 || !description || description.length > 2000) throw new ValidationError('Panel text cannot be blank or exceed its character limit.');
      session.draft.panelTitle = title;
      session.draft.panelDescription = description;
    } else if (['categoryId', 'supportRoleId', 'logChannelId', 'panelChannelId'].includes(action)) {
      const value = interaction.values?.[0];
      if (!/^\d{17,20}$/.test(value || '')) throw new ValidationError('Select one valid channel or role.');
      if (action === 'supportRoleId' && value === session.guild.id) throw new ValidationError('@everyone would expose all tickets. Choose a staff role.');
      session.draft[action] = value;
    } else if (action === 'save' || action === 'publish') {
      // Validate against current open tickets, not the snapshot taken when the wizard opened.
      const draft = { ...session.draft, open: tickets.readSettings(config.misc).open };
      await tickets.validateSetup(session.guild, draft, { publish: action === 'publish' });
      const saved = await tickets.saveSetup(session.guild.id, draft);
      if (action === 'publish') {
        try {
          const channel = await session.guild.channels.fetch(saved.panelChannelId);
          await tickets.postPanel(session.guild, channel, { misc: { tickets: saved } });
        } catch (error) {
          throw new ValidationError('Settings were saved, but the panel could not be posted. Check permissions and use ticketpanel to publish it.');
        }
      }
      destroy(id);
      await interaction.editReply({ embeds: [successEmbed({ title: 'Ticket Setup Saved', description: action === 'publish'
        ? `Your ticket panel is ready in <#${saved.panelChannelId}>. Members can now submit a subject and description to open a ticket.`
        : 'Settings saved. Use ticketpanel to publish the panel when you are ready.' })], components: [] });
      return true;
    } else throw new ValidationError('Unknown setup control. Run ticketsetup again.');
    await interaction.editReply(render(session));
  } catch (error) {
    log.warn('Ticket setup failed', { code: error.code, message: error.message });
    const payload = { embeds: [errorEmbed({ title: 'Ticket Setup', description: error instanceof ValidationError ? error.message : 'Could not complete this change. Check permissions and storage, then try again.' })], ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => null);
    else await interaction.reply(payload).catch(() => null);
  } finally {
    session.busy = false;
  }
  return true;
}

module.exports = { start, handleComponent, render, destroy, sessions };
