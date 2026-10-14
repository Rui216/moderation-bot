'use strict';

/** Private support channels. Durable state lives in guild misc.tickets. */
const {
  AttachmentBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ChannelType,
  PermissionFlagsBits: P, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { COLORS } = require('../config/constants');
const { baseEmbed, errorEmbed, successEmbed } = require('../utils/embeds');
const { ValidationError, isUserError } = require('../utils/errors');
const rateLimit = require('./rateLimitService');
const { logger } = require('../utils/logger');
const { createKeyedQueue } = require('../utils/keyedQueue');
const { repo } = require('../db');

const log = logger.child('tickets');
const operations = createKeyedQueue();
const MAX_OPEN_TICKETS = 100;
const MAX_TRANSCRIPT_MESSAGES = 10000;
const MAX_TRANSCRIPT_BYTES = 7 * 1024 * 1024;
const OPENER_PERMISSIONS = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks];
const BOT_PERMISSIONS = [...OPENER_PERMISSIONS, P.ManageChannels, P.ManageMessages];
const DEFAULT_TITLE = 'Support Tickets';
const DEFAULT_DESCRIPTION = 'Need help from the staff team? Press the button below to open a private ticket.';

function readSettings(misc) {
  const raw = misc?.tickets || {};
  return {
    categoryId: raw.categoryId || null,
    supportRoleId: raw.supportRoleId || null,
    logChannelId: raw.logChannelId || null,
    panelChannelId: raw.panelChannelId || null,
    panelTitle: String(raw.panelTitle || DEFAULT_TITLE).slice(0, 100),
    panelDescription: String(raw.panelDescription || DEFAULT_DESCRIPTION).slice(0, 2000),
    counter: Number.isSafeInteger(raw.counter) && raw.counter >= 0 ? raw.counter : 0,
    open: raw.open && typeof raw.open === 'object' && !Array.isArray(raw.open) ? { ...raw.open } : {},
  };
}

async function updateSettings(guildId, mutate) {
  let next;
  await repo('guilds').mutateMisc(guildId, (misc) => {
    next = mutate(readSettings(misc));
    return { ...misc, tickets: next };
  });
  return next;
}

function saveSetup(guildId, values) {
  const fields = ['categoryId', 'supportRoleId', 'logChannelId', 'panelChannelId', 'panelTitle', 'panelDescription'];
  return operations(guildId, () => updateSettings(guildId, (settings) => {
    for (const field of fields) if (values[field] !== undefined) settings[field] = values[field];
    return readSettings({ tickets: settings });
  }));
}

/** Only a definite Unknown Channel counts as deleted; network errors must propagate. */
async function fetchChannel(guild, id) {
  return guild.channels.fetch(id).catch((error) => {
    if (error.code === 10003) return null;
    throw error;
  });
}

function assertPermissions(channel, member, permissions, purpose) {
  if (!member || !channel.permissionsFor(member)?.has(permissions)) {
    throw new ValidationError(`The bot needs ${purpose} permissions in <#${channel.id}>. Check its role and channel overrides.`);
  }
}

function assertTextChannel(channel, purpose) {
  if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
    throw new ValidationError(`${purpose} must be a server text or announcement channel.`);
  }
}

/** Revalidate actual Discord resources before saving or creating tickets. */
async function validateSetup(guild, settings, { publish = false } = {}) {
  if (!settings.categoryId || !settings.supportRoleId || !settings.logChannelId) {
    throw new ValidationError('Select a ticket category, support role, and transcript log channel first.');
  }
  const category = await fetchChannel(guild, settings.categoryId);
  if (!category || category.type !== ChannelType.GuildCategory) throw new ValidationError('Select an existing ticket category.');
  const role = await guild.roles.fetch(settings.supportRoleId);
  if (!role || role.id === guild.id || role.managed) {
    throw new ValidationError('Choose a normal staff role, not @everyone or a bot/integration role.');
  }
  const me = guild.members.me || await guild.members.fetchMe();
  assertPermissions(category, me, [P.ViewChannel, P.ManageChannels, P.ManageRoles], 'View Channel, Manage Channels, and Manage Roles');
  const logChannel = await fetchChannel(guild, settings.logChannelId);
  assertTextChannel(logChannel, 'The transcript destination');
  if (settings.open?.[logChannel.id]) throw new ValidationError('A ticket channel cannot be its own transcript destination.');
  assertPermissions(logChannel, me, [P.ViewChannel, P.SendMessages, P.AttachFiles, P.EmbedLinks], 'View Channel, Send Messages, Attach Files, and Embed Links');
  if (publish) {
    const panel = await fetchChannel(guild, settings.panelChannelId);
    assertTextChannel(panel, 'The panel destination');
    if (settings.open?.[panel.id]) throw new ValidationError('Publish the panel outside ticket channels.');
    assertPermissions(panel, me, [P.ViewChannel, P.SendMessages, P.EmbedLinks], 'View Channel, Send Messages, and Embed Links');
  }
  return { category, role, logChannel };
}

async function findOpenTicketFor(guild, userId, settings) {
  for (const [channelId, ticket] of Object.entries(settings.open)) {
    if (ticket.userId !== userId) continue;
    const channel = await fetchChannel(guild, channelId);
    if (channel) return channel;
  }
  return null;
}

function canManageTicket(member, ticket, settings) {
  return Boolean(member && (member.id === ticket?.userId
    || member.roles?.cache?.has(settings.supportRoleId)
    || member.permissions?.has(P.ManageChannels)));
}

function button(id, label, style) {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
}
function closeButtonRow() {
  return new ActionRowBuilder().addComponents(button('ticket:close', 'Close Ticket', ButtonStyle.Danger));
}
function confirmButtonRow() {
  return new ActionRowBuilder().addComponents(
    button('ticket:confirm-close', 'Save transcript & close', ButtonStyle.Danger),
    button('ticket:cancel-close', 'Keep open', ButtonStyle.Secondary),
  );
}
function panelEmbed(guild, settings) {
  return baseEmbed({ title: settings.panelTitle, description: settings.panelDescription, color: COLORS.info, footer: guild.name });
}
async function postPanel(guild, channel, config) {
  const settings = { ...readSettings(config.misc), panelChannelId: channel?.id };
  await validateSetup(guild, settings, { publish: true });
  const embed = panelEmbed(guild, settings);
  await channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(
    button('ticket:open', 'Open Ticket', ButtonStyle.Primary),
  )], allowedMentions: { parse: [] } });
  return embed;
}

function ticketModal() {
  return new ModalBuilder().setCustomId('ticket:submit').setTitle('Open a support ticket').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('subject').setLabel('What do you need help with?')
      .setStyle(TextInputStyle.Short).setMinLength(3).setMaxLength(100).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('details').setLabel('Describe your question or issue')
      .setStyle(TextInputStyle.Paragraph).setMinLength(10).setMaxLength(2000).setRequired(true)),
  );
}

function openTicket(client, interaction, input = {}) {
  return operations(interaction.guild.id, async () => {
    const { guild, user } = interaction;
    const config = await repo('guilds').getConfig(guild.id, { force: true });
    const settings = readSettings(config.misc);
    const existing = await findOpenTicketFor(guild, user.id, settings);
    if (existing) return { channel: existing, existing: true };

    // Reconcile manually deleted tickets without treating a Discord outage as deletion.
    const stale = [];
    for (const id of Object.keys(settings.open)) if (!await fetchChannel(guild, id)) stale.push(id);
    if (stale.length) await updateSettings(guild.id, (current) => {
      for (const id of stale) { delete current.open[id]; delete settings.open[id]; }
      return current;
    });
    if (Object.keys(settings.open).length >= MAX_OPEN_TICKETS) throw new ValidationError('The ticket limit has been reached. Please wait for staff to close some tickets.');
    const { category } = await validateSetup(guild, settings);
    if (category.children?.cache?.size >= 50) throw new ValidationError('The ticket category is full. Ask an administrator to select another category.');
    let number;
    await updateSettings(guild.id, (current) => {
      number = current.counter + 1;
      if (!Number.isSafeInteger(number)) throw new ValidationError('Ticket counter is out of range. Contact an administrator.');
      return { ...current, counter: number };
    });
    const name = `ticket-${String(number).padStart(4, '0')}`;
    const channel = await guild.channels.create({
      name, type: ChannelType.GuildText, parent: category.id,
      topic: `Support ticket #${number} | Owner: ${user.id}`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
        { id: user.id, allow: OPENER_PERMISSIONS },
        { id: settings.supportRoleId, allow: OPENER_PERMISSIONS },
        { id: client.user.id, allow: BOT_PERMISSIONS },
      ], reason: `Ticket ${name} opened`,
    });
    try {
      await updateSettings(guild.id, (current) => ({ ...current, open: {
        ...current.open, [channel.id]: { userId: user.id, number, openedAt: Date.now() },
      } }));
    } catch (error) {
      // Do not leave an untracked support channel after a failed database write.
      await channel.delete('Ticket storage failed; rolling back').catch((cleanupError) => {
        log.error('Untracked ticket needs manual cleanup', { channelId: channel.id, code: cleanupError.code });
      });
      throw error;
    }
    try {
      await channel.send({
        content: `<@${user.id}> <@&${settings.supportRoleId}>`,
        embeds: [baseEmbed({ title: `Ticket ${String(number).padStart(4, '0')}`, color: COLORS.info,
          description: input.details || 'Describe your question or issue. A staff member will reply here.',
          fields: input.subject ? [{ name: 'Subject', value: input.subject }] : [], footer: guild.name })],
        components: [closeButtonRow()], allowedMentions: { users: [user.id], roles: [settings.supportRoleId] },
      });
    } catch (error) {
      // Keep the durable record so the owner can retry and staff can still close it.
      log.warn('Ticket welcome failed', { channelId: channel.id, code: error.code });
      throw new ValidationError(`Your ticket was created at <#${channel.id}>, but its welcome message could not be sent. Ask staff to check the bot's permissions.`);
    }
    log.info('Ticket opened', { guildId: guild.id, number });
    return { channel, existing: false };
  });
}

/** Paginate full history. Never delete a channel after a partial/failed export. */
async function buildTranscript(channel) {
  const pages = [];
  let before;
  let count = 0;
  let bytes = 0;
  while (true) {
    const fetched = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    const messages = Array.from(fetched.values());
    if (!messages.length) break;
    count += messages.length;
    if (count > MAX_TRANSCRIPT_MESSAGES) throw new ValidationError('This ticket exceeds 10,000 messages. Export it manually before closing; the channel has been kept.');
    const lines = messages.map((message) => {
      const parts = [message.content || ''];
      for (const attachment of message.attachments.values()) parts.push(`[attachment] ${attachment.url}`);
      for (const embed of message.embeds) {
        parts.push(`[embed] ${JSON.stringify(embed.toJSON ? embed.toJSON() : embed)}`);
      }
      return `[${new Date(message.createdTimestamp).toISOString()}] ${message.author?.tag || 'unknown'} (${message.author?.id || '?'}) [${message.id}]: ${parts.join(' ')}`;
    });
    const page = lines.reverse().join('\n');
    bytes += Buffer.byteLength(page, 'utf8') + 1;
    if (bytes > MAX_TRANSCRIPT_BYTES) throw new ValidationError('The transcript exceeds 7 MiB. Export it manually; the channel has been kept.');
    pages.unshift(page);
    const next = messages[messages.length - 1].id;
    if (messages.length < 100) break;
    if (!next || next === before) throw new ValidationError('Transcript pagination failed; the channel has been kept.');
    before = next;
  }
  return `Ticket transcript: ${channel.name} (${channel.id})\nExported: ${new Date().toISOString()}\nMessages: ${count}\nAttachment URLs may expire; files are not archived.\n\n${pages.join('\n') || 'No messages were recorded.'}`;
}

function closeTicket({ guild, channel, closedBy, member }) {
  return operations(guild.id, async () => {
    const config = await repo('guilds').getConfig(guild.id, { force: true });
    const settings = readSettings(config.misc);
    const ticket = settings.open[channel.id];
    if (!ticket) throw new ValidationError('This channel is not an open ticket.');
    const actor = member || await guild.members.fetch(closedBy.id);
    if (!canManageTicket(actor, ticket, settings)) throw new ValidationError('Only the ticket owner or staff can close this ticket.');
    if (!settings.logChannelId || settings.logChannelId === channel.id) throw new ValidationError('Configure a separate transcript log channel before closing this ticket.');
    const logChannel = await fetchChannel(guild, settings.logChannelId);
    assertTextChannel(logChannel, 'The transcript destination');
    const label = `ticket-${String(ticket.number).padStart(4, '0')}`;
    const transcript = await buildTranscript(channel);
    // Both fetch and upload must succeed. Never swallow errors and destroy the evidence.
    await logChannel.send({
      embeds: [baseEmbed({ title: 'Ticket Transcript', color: COLORS.neutral,
        description: 'Transcript saved before channel deletion. If deletion fails, the ticket remains open.',
        fields: [{ name: 'Ticket', value: label, inline: true },
          { name: 'Opened By', value: `<@${ticket.userId}>`, inline: true },
          { name: 'Closed By', value: `<@${closedBy.id}>`, inline: true }], footer: guild.name })],
      files: [new AttachmentBuilder(Buffer.from(transcript, 'utf8'), { name: `${label}.txt` })],
      allowedMentions: { parse: [] },
    });
    await channel.delete(`Ticket ${label} closed by ${closedBy.id}`);
    // A failed Discord delete leaves the record intact and retryable.
    await updateSettings(guild.id, (current) => {
      delete current.open[channel.id];
      return current;
    });
    log.info('Ticket closed', { guildId: guild.id, number: ticket.number });
  });
}

function closePrompt() {
  return { embeds: [baseEmbed({ title: 'Close This Ticket?', color: COLORS.warn,
    description: 'Save a transcript to the configured log channel, then permanently delete this channel. If the export fails, the ticket stays open.' })], components: [confirmButtonRow()] };
}

async function handleComponent(client, interaction) {
  if (!interaction.customId?.startsWith('ticket:') || !interaction.guild) return false;
  try {
    if (interaction.customId === 'ticket:open') {
      await interaction.showModal(ticketModal());
      return true;
    }
    if (interaction.customId === 'ticket:submit') {
      await interaction.deferReply({ ephemeral: true });
      rateLimit.consume(interaction.guild.id, interaction.user.id, 'command');
      const subject = interaction.fields.getTextInputValue('subject').trim();
      const details = interaction.fields.getTextInputValue('details').trim();
      if (subject.length < 3 || subject.length > 100 || details.length < 10 || details.length > 2000) throw new ValidationError('Provide a subject (3–100 characters) and description (10–2,000 characters).');
      const { channel, existing } = await openTicket(client, interaction, { subject, details });
      await interaction.editReply({ embeds: [successEmbed({ title: existing ? 'You already have a ticket open' : 'Ticket Created', description: `Your ticket is <#${channel.id}>.` })] });
      return true;
    }
    if (interaction.customId === 'ticket:cancel-close') {
      await interaction.update({ embeds: [baseEmbed({ title: 'Ticket Kept Open', color: COLORS.info })], components: [] });
      return true;
    }
    if (['ticket:close', 'ticket:confirm-close'].includes(interaction.customId)) {
      rateLimit.consume(interaction.guild.id, interaction.user.id, 'command');
      const confirm = interaction.customId === 'ticket:confirm-close';
      if (confirm) await interaction.deferUpdate();
      else await interaction.deferReply({ ephemeral: true });
      const settings = readSettings((await repo('guilds').getConfig(interaction.guild.id, { force: true })).misc);
      const ticket = settings.open[interaction.channelId];
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!ticket || !canManageTicket(member, ticket, settings)) throw new ValidationError('Only the ticket owner or staff can close an open ticket.');
      if (!confirm) await interaction.editReply(closePrompt());
      else {
        const channel = await fetchChannel(interaction.guild, interaction.channelId);
        if (!channel) throw new ValidationError('This ticket channel no longer exists.');
        await closeTicket({ guild: interaction.guild, channel, closedBy: interaction.user, member });
        await interaction.editReply({ embeds: [successEmbed({ title: 'Ticket Closed', description: 'Transcript saved and channel deleted.' })], components: [] }).catch(() => null);
      }
      return true;
    }
    throw new ValidationError('This ticket control is no longer supported. Ask staff to publish a new panel.');
  } catch (error) {
    log.warn('Ticket action failed', { code: error.code, message: error.message });
    const payload = { embeds: [errorEmbed({ title: 'Ticket Action Needs Attention', description: isUserError(error) ? error.message : 'The operation could not finish. Check bot permissions and storage, then try again. The ticket may still be open.' })], components: [] };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => null);
    else await interaction.reply({ ...payload, ephemeral: true }).catch(() => null);
    return true;
  }
}

module.exports = { readSettings, updateSettings, saveSetup, validateSetup, postPanel, panelEmbed,
  openTicket, closeTicket, buildTranscript, closePrompt, canManageTicket, findOpenTicketFor, handleComponent };
