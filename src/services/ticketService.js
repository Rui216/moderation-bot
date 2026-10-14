'use strict';

const { EPHEMERAL } = require('../utils/flags');

/**
 * Support tickets.
 *
 * A panel message carries an "Open Ticket" button. Each press creates a
 * private text channel under the configured category, visible only to the
 * member, the support role, and the bot. Closing a ticket saves a plain-text
 * transcript to the log channel and then deletes the channel.
 *
 * State lives in the guild's misc configuration under the "tickets" key:
 *   { categoryId, supportRoleId, logChannelId, counter, open: { channelId: {...} } }
 * No schema change is needed, and the Worker stores it as it does other
 * extensible guild state.
 */

const {
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');

const { COLORS } = require('../config/constants');
const { baseEmbed, errorEmbed, successEmbed } = require('../utils/embeds');
const { ValidationError } = require('../utils/errors');
const { logger } = require('../utils/logger');
const { repo } = require('../db');
const { withLock } = require('../utils/keyedLock');

const log = logger.child('tickets');

const MAX_OPEN_TICKETS = 100;
const TRANSCRIPT_MESSAGES = 100;

const OPENER_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
];

const BOT_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
];

/* ------------------------------------------------------------ state helpers */

/** Read the tickets block from a guild config, filling in defaults. */
function readSettings(misc) {
  const raw = (misc && misc.tickets) || {};
  return {
    categoryId: raw.categoryId || null,
    supportRoleId: raw.supportRoleId || null,
    logChannelId: raw.logChannelId || null,
    counter: Number.isInteger(raw.counter) ? raw.counter : 0,
    open: raw.open && typeof raw.open === 'object' ? { ...raw.open } : {},
  };
}

/**
 * Read-modify-write the tickets block. The configuration is reloaded first so
 * a recent change is not overwritten.
 * @param {string} guildId
 * @param {(settings: object) => object} mutate
 */
async function updateSettings(guildId, mutate) {
  const config = await repo('guilds').getConfig(guildId, { force: true });
  const misc = { ...(config.misc || {}) };
  const next = mutate(readSettings(misc));
  misc.tickets = next;
  await repo('guilds').updateConfig(guildId, { misc });
  return next;
}

/** Find the open ticket that belongs to a member, if its channel still exists. */
async function findOpenTicketFor(guild, userId, settings) {
  for (const [channelId, ticket] of Object.entries(settings.open)) {
    if (ticket.userId !== userId) continue;
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (channel) return channel;
  }
  return null;
}

/** Whether a member may close a ticket: the opener, the support role, or a channel manager. */
function canManageTicket(member, ticket, settings) {
  if (!member) return false;
  if (ticket && member.id === ticket.userId) return true;
  if (settings.supportRoleId && member.roles && member.roles.cache.has(settings.supportRoleId)) return true;
  return Boolean(member.permissions && member.permissions.has(PermissionFlagsBits.ManageChannels));
}

/* ----------------------------------------------------------------- components */

function openButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:open').setLabel('Open Ticket').setStyle(ButtonStyle.Primary),
  );
}

function closeButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger),
  );
}

function confirmButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:confirm-close').setLabel('Confirm Close').setStyle(ButtonStyle.Danger),
  );
}

/* ---------------------------------------------------------------- panel/setup */

/**
 * Post the panel with the Open Ticket button into a channel.
 * @returns {Promise<object>} the embed that was posted
 */
async function postPanel(guild, channel, config) {
  const settings = readSettings(config.misc);
  if (!settings.categoryId || !settings.supportRoleId) {
    throw new ValidationError('Tickets are not set up yet. Run ticketsetup first.');
  }
  const embed = baseEmbed({
    title: 'Support Tickets',
    color: COLORS.info,
    description: 'Need help from the staff team? Press the button below to open a private ticket.',
    footer: guild.name,
  });
  await channel.send({ embeds: [embed], components: [openButtonRow()] });
  return embed;
}

/**
 * Save ticket settings. Only the values provided are changed.
 * @param {string} guildId
 * @param {{categoryId?: string, supportRoleId?: string, logChannelId?: string}} values
 */
async function saveSetupUnlocked(guildId, values) {
  return updateSettings(guildId, (settings) => ({
    ...settings,
    ...(values.categoryId !== undefined ? { categoryId: values.categoryId } : {}),
    ...(values.supportRoleId !== undefined ? { supportRoleId: values.supportRoleId } : {}),
    ...(values.logChannelId !== undefined ? { logChannelId: values.logChannelId } : {}),
  }));
}

/* ----------------------------------------------------------------- open flow */

/**
 * Create a ticket channel for the pressing member.
 * @returns {Promise<{channel: object, existing: boolean}>}
 */
async function openTicketUnlocked(client, interaction) {
  const guild = interaction.guild;
  const user = interaction.user;
  const config = await repo('guilds').getConfig(guild.id, { force: true });
  const settings = readSettings(config.misc);

  if (!settings.categoryId || !settings.supportRoleId) {
    throw new ValidationError('Tickets are not set up yet. An administrator needs to run ticketsetup.');
  }

  const existing = await findOpenTicketFor(guild, user.id, settings);
  if (existing) return { channel: existing, existing: true };

  if (Object.keys(settings.open).length >= MAX_OPEN_TICKETS) {
    throw new ValidationError('The ticket limit has been reached. Try again after some tickets are closed.');
  }

  const category = await guild.channels.fetch(settings.categoryId).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) {
    throw new ValidationError('The ticket category no longer exists. An administrator needs to run ticketsetup.');
  }

  // Reserve the next ticket number first so two presses cannot share one.
  let number = 0;
  await updateSettings(guild.id, (current) => {
    number = current.counter + 1;
    return { ...current, counter: number };
  });

  const name = `ticket-${String(number).padStart(4, '0')}`;
  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, allow: OPENER_PERMISSIONS },
      { id: settings.supportRoleId, allow: OPENER_PERMISSIONS },
      { id: client.user.id, allow: BOT_PERMISSIONS },
    ],
    reason: `Ticket ${name} opened`,
  });

  await updateSettings(guild.id, (current) => ({
    ...current,
    open: {
      ...current.open,
      [channel.id]: { userId: user.id, number, openedAt: Date.now() },
    },
  }));

  const welcome = baseEmbed({
    title: `Ticket ${String(number).padStart(4, '0')}`,
    color: COLORS.info,
    description: 'Describe your question or issue. A staff member will reply here. Press Close Ticket when you are finished.',
    footer: guild.name,
  });
  await channel.send({
    content: `<@${user.id}> <@&${settings.supportRoleId}>`,
    embeds: [welcome],
    components: [closeButtonRow()],
    allowedMentions: { users: [user.id], roles: [settings.supportRoleId] },
  });

  log.info('Ticket opened', { guildId: guild.id, number });
  return { channel, existing: false };
}

/* ---------------------------------------------------------------- close flow */

/** Build the plain-text transcript of the most recent messages in a ticket. */
async function buildTranscript(channel) {
  const fetched = await channel.messages.fetch({ limit: TRANSCRIPT_MESSAGES }).catch(() => null);
  const messages = fetched ? Array.from(fetched.values()).reverse() : [];

  const lines = messages.map((message) => {
    const time = new Date(message.createdTimestamp).toISOString();
    const author = message.author ? `${message.author.tag || message.author.id}` : 'unknown';
    const parts = [];
    if (message.content) parts.push(message.content);
    for (const attachment of message.attachments.values()) parts.push(`[attachment] ${attachment.url}`);
    if (message.embeds.length > 0) parts.push(`[${message.embeds.length} embed(s)]`);
    return `[${time}] ${author}: ${parts.join(' ') || '(no text)'}`;
  });

  return lines.length > 0 ? lines.join('\n') : 'No messages were recorded.';
}

/**
 * Save the transcript to the log channel, remove the ticket, and delete the channel.
 * @returns {Promise<void>}
 */
async function closeTicketUnlocked({ client, guild, channel, closedBy }) {
  const config = await repo('guilds').getConfig(guild.id, { force: true });
  const settings = readSettings(config.misc);
  const ticket = settings.open[channel.id];
  if (!ticket) throw new ValidationError('This channel is not an open ticket.');

  const label = `ticket-${String(ticket.number).padStart(4, '0')}`;
  const transcript = await buildTranscript(channel);

  if (settings.logChannelId) {
    const logChannel = await guild.channels.fetch(settings.logChannelId).catch(() => null);
    if (logChannel && logChannel.isTextBased()) {
      const embed = baseEmbed({
        title: 'Ticket Closed',
        color: COLORS.neutral,
        fields: [
          { name: 'Ticket', value: label, inline: true },
          { name: 'Opened By', value: `<@${ticket.userId}>`, inline: true },
          { name: 'Closed By', value: `<@${closedBy.id}>`, inline: true },
        ],
        footer: guild.name,
      });
      const file = new AttachmentBuilder(Buffer.from(transcript, 'utf8'), { name: `${label}.txt` });
      await logChannel.send({ embeds: [embed], files: [file], allowedMentions: { parse: [] } }).catch((error) => {
        log.warn('Transcript could not be posted', { code: error && error.code });
      });
    }
  }

  // Remove the ticket record before deleting the channel, so a failed delete
  // never leaves a record pointing at a channel that is already gone.
  await updateSettings(guild.id, (current) => {
    const open = { ...current.open };
    delete open[channel.id];
    return { ...current, open };
  });

  await channel.delete(`Ticket ${label} closed`);
  log.info('Ticket closed', { guildId: guild.id, number: ticket.number });
}

/* ------------------------------------------------------------------ queue */

/**
 * Ticket actions for one server run one at a time. Two members pressing Open
 * Ticket at the same moment therefore get separate numbers and never both
 * create a channel for the same person.
 */
function ticketLock(guildId) {
  return `tickets:${guildId}`;
}

function openTicket(client, interaction) {
  return withLock(ticketLock(interaction.guild.id), () => openTicketUnlocked(client, interaction));
}

function closeTicket(options) {
  return withLock(ticketLock(options.guild.id), () => closeTicketUnlocked(options));
}

function saveSetup(guildId, values) {
  return withLock(ticketLock(guildId), () => saveSetupUnlocked(guildId, values));
}

/* -------------------------------------------------------- component routing */

/**
 * Handle the ticket buttons. Returns false for any other component so the
 * setup wizard and other handlers can take it.
 * @returns {Promise<boolean>} true when the interaction was handled
 */
async function handleComponent(client, interaction) {
  if (!interaction.customId || !interaction.customId.startsWith('ticket:')) return false;
  if (!interaction.guild) return false;

  try {
    if (interaction.customId === 'ticket:open') {
      await interaction.deferReply({ flags: EPHEMERAL });
      const { channel, existing } = await openTicket(client, interaction);
      await interaction.editReply({
        embeds: [existing
          ? noticeFor('You already have a ticket open', `Your ticket is <#${channel.id}>.`)
          : successEmbed({ title: 'Ticket Created', description: `Your ticket is ready: <#${channel.id}>` })],
      });
      return true;
    }

    if (interaction.customId === 'ticket:close') {
      const config = await repo('guilds').getConfig(interaction.guild.id);
      const settings = readSettings(config.misc);
      const ticket = settings.open[interaction.channelId];
      if (!ticket) {
        await interaction.reply({ embeds: [errorEmbed({ title: 'Not A Ticket', description: 'This channel is not an open ticket.' })], flags: EPHEMERAL });
        return true;
      }
      if (!canManageTicket(interaction.member, ticket, settings)) {
        await interaction.reply({ embeds: [errorEmbed({ title: 'Not Allowed', description: 'Only the ticket owner or staff can close this ticket.' })], flags: EPHEMERAL });
        return true;
      }
      await interaction.reply({
        embeds: [baseEmbed({ title: 'Close This Ticket?', color: COLORS.warn, description: 'The channel will be deleted. A transcript is saved to the log channel first.' })],
        components: [confirmButtonRow()],
        flags: EPHEMERAL,
      });
      return true;
    }

    if (interaction.customId === 'ticket:confirm-close') {
      const config = await repo('guilds').getConfig(interaction.guild.id);
      const settings = readSettings(config.misc);
      const ticket = settings.open[interaction.channelId];
      if (!ticket || !canManageTicket(interaction.member, ticket, settings)) {
        await interaction.update({ embeds: [errorEmbed({ title: 'Not Allowed', description: 'This ticket cannot be closed from here.' })], components: [] });
        return true;
      }
      await interaction.deferUpdate();
      const channel = await interaction.guild.channels.fetch(interaction.channelId).catch(() => null);
      if (channel) {
        await closeTicket({ client, guild: interaction.guild, channel, closedBy: interaction.user });
      }
      return true;
    }
  } catch (error) {
    log.warn('Ticket action failed', { code: error && error.code, message: error && error.message });
    const embed = error instanceof ValidationError
      ? errorEmbed({ title: 'Ticket Not Changed', description: error.message })
      : errorEmbed({ title: 'Command Failed' });
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ embeds: [embed] }).catch(() => null);
    } else {
      await interaction.reply({ embeds: [embed], flags: EPHEMERAL }).catch(() => null);
    }
    return true;
  }

  return false;
}

function noticeFor(title, description) {
  return baseEmbed({ title, color: COLORS.info, description });
}

module.exports = {
  readSettings,
  updateSettings,
  saveSetup,
  postPanel,
  openTicket,
  closeTicket,
  canManageTicket,
  findOpenTicketFor,
  handleComponent,
};
