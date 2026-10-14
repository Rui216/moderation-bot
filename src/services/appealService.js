'use strict';

/**
 * Ban appeals.
 *
 * Flow:
 *   1. The bot bans (or temp-bans) a member and appeals are enabled. It DMs the
 *      member BEFORE the ban is applied, with an "Appeal this ban" button. A
 *      banned user shares no server with the bot, so a DM sent afterwards would
 *      almost never be delivered.
 *   2. The member presses the button in DMs. The bot checks that the ban is
 *      still active and was issued by the bot, then opens a modal.
 *   3. The submission is posted to the appeals channel with Approve and Deny
 *      buttons. Staff (moderator level or above) decide.
 *   4. Approve lifts the ban through the normal unban pipeline, which creates a
 *      case, writes the log entry, and DMs the member. Deny DMs the member.
 *
 * Limits:
 *   - Only bans applied through the bot have a punishment record, so manual
 *     Discord bans cannot be appealed here.
 *   - A DM is delivered only if the member accepts direct messages from the bot.
 *   - Button and modal interactions can come from DMs, where there is no guild
 *     context. Each one is accepted only after the ban check passes.
 *   - One submission per member per server per 24 hours. This is tracked in
 *     memory and resets on restart.
 */

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
} = require('discord.js');

const { COLORS } = require('../config/constants');
const { baseEmbed, errorEmbed, successEmbed } = require('../utils/embeds');
const { EPHEMERAL } = require('../utils/flags');
const { sanitizeReason } = require('../utils/sanitize');
const { formatDuration } = require('../utils/duration');
const { repo } = require('../db');
const { logger } = require('../utils/logger');
const permissionService = require('./permissionService');

const log = logger.child('appeals');

/** Minimum time between two submissions from one member to one server. */
const APPEAL_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Longest appeal text accepted from the modal. */
const MAX_APPEAL_LENGTH = 1000;

/** Last submission time keyed by guild and user. */
const recentSubmissions = new Map();

/** Read the appeals block from the guild's misc configuration. */
function readAppeals(misc) {
  const raw = (misc && misc.appeals) || {};
  return {
    enabled: raw.enabled === true,
    channelId: typeof raw.channelId === 'string' && raw.channelId ? raw.channelId : null,
  };
}

/** True when appeals are switched on and have a channel to post to. */
function appealsOpen(config) {
  const appeals = readAppeals(config && config.misc);
  return appeals.enabled && Boolean(appeals.channelId);
}

/** Milliseconds until the member may submit again, or 0 when allowed now. */
function cooldownRemaining(guildId, userId) {
  const last = recentSubmissions.get(`${guildId}:${userId}`);
  if (!last) return 0;
  return Math.max(0, last + APPEAL_COOLDOWN_MS - Date.now());
}

/** Button row for the member's DM. */
function appealButtonRow(guildId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`appeal:open:${guildId}`).setLabel('Appeal this ban').setStyle(ButtonStyle.Primary),
  );
}

/**
 * DM a member that a ban is about to be applied, with the appeal button.
 * Call this BEFORE the Discord ban call.
 *
 * @returns {Promise<{offered: boolean, delivered: boolean, reason?: string}>}
 *   offered is false when appeals are off, in which case nothing was sent.
 */
async function sendBanNotice({ guild, config, user, reason, durationMs = null }) {
  if (!appealsOpen(config)) return { offered: false, delivered: false };

  const embed = baseEmbed({
    title: `You were banned from ${guild.name}`,
    description: [
      durationMs ? 'This is a temporary ban.' : 'This is a permanent ban.',
      'If you think this was a mistake, press **Appeal this ban**. Your appeal goes to the server staff.',
    ].join('\n'),
    color: COLORS.ban,
    fields: [
      { name: 'Reason', value: reason || 'No reason provided', inline: false },
      ...(durationMs ? [{ name: 'Duration', value: formatDuration(durationMs), inline: true }] : []),
    ],
    footer: guild.name,
  });

  try {
    await user.send({ embeds: [embed], components: [appealButtonRow(guild.id)] });
    return { offered: true, delivered: true };
  } catch (error) {
    const code = error && error.code;
    log.debug('Ban appeal notice not delivered', { guildId: guild.id, code });
    // 50007: the member has direct messages closed.
    return { offered: true, delivered: false, reason: code === 50007 ? 'dms-closed' : 'failed' };
  }
}

/**
 * Confirm that an appeal is allowed: appeals are open, the member is banned,
 * and the ban was issued by the bot.
 *
 * @returns {Promise<{ok: true, guild, config, channelId} | {ok: false, message: string}>}
 */
async function checkEligibility(client, guildId, userId) {
  const guild = client.guilds.cache.get(guildId) || null;
  if (!guild) return { ok: false, message: 'The bot is no longer in that server.' };

  const config = await repo('guilds').getConfig(guildId).catch(() => null);
  if (!appealsOpen(config)) return { ok: false, message: 'Appeals are not open in that server.' };

  const ban = await guild.bans.fetch(userId).catch(() => null);
  if (!ban) return { ok: false, message: 'You are not banned from that server, so there is nothing to appeal.' };

  // The punishment row exists only for bans applied through the bot.
  const punishments = await repo('punishments').list(guildId, userId).catch(() => []);
  const botBan = (Array.isArray(punishments) ? punishments : []).some((row) => row && row.type === 'ban');
  if (!botBan) return { ok: false, message: 'This ban was not issued by the bot, so it cannot be appealed here.' };

  return { ok: true, guild, config, channelId: readAppeals(config.misc).channelId };
}

/**
 * Route an appeal component or modal interaction.
 *
 * @returns {Promise<boolean>} true when the interaction was consumed
 */
async function handleInteraction(client, deps, interaction) {
  const [namespace, action, guildId, userId] = String(interaction.customId || '').split(':');
  if (namespace !== 'appeal') return false;

  if (interaction.isButton() && action === 'open') {
    await openModal(client, interaction, guildId);
    return true;
  }
  if (interaction.isModalSubmit() && action === 'submit') {
    await submitAppeal(client, interaction, guildId);
    return true;
  }
  if (interaction.isButton() && (action === 'approve' || action === 'deny')) {
    await decide(client, deps, interaction, action, guildId, userId);
    return true;
  }
  return false;
}

/** Reply with an ephemeral embed. */
function ephemeral(interaction, embed) {
  const payload = { embeds: [embed], flags: EPHEMERAL };
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload).catch(() => null);
  return interaction.reply(payload).catch(() => null);
}

/** Member pressed "Appeal this ban": check eligibility, then show the modal. */
async function openModal(client, interaction, guildId) {
  if (interaction.inGuild()) {
    await ephemeral(interaction, errorEmbed({
      title: 'Use Direct Messages',
      description: 'Press the appeal button in your direct messages with the bot.',
    }));
    return;
  }

  const check = await checkEligibility(client, guildId, interaction.user.id);
  if (!check.ok) {
    await ephemeral(interaction, errorEmbed({ title: 'Appeal Unavailable', description: check.message }));
    return;
  }

  const wait = cooldownRemaining(guildId, interaction.user.id);
  if (wait > 0) {
    await ephemeral(interaction, errorEmbed({
      title: 'Appeal Already Sent',
      description: `You sent an appeal recently. You can send another in about ${Math.ceil(wait / 3600000)} hour(s).`,
    }));
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`appeal:submit:${guildId}`)
    .setTitle('Ban appeal')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Why should this ban be lifted?')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMinLength(10)
        .setMaxLength(MAX_APPEAL_LENGTH),
    ));

  await interaction.showModal(modal);
}

/** Modal submitted: post the appeal to the staff channel. */
async function submitAppeal(client, interaction, guildId) {
  await interaction.deferReply({ flags: EPHEMERAL }).catch(() => null);
  const user = interaction.user;

  const check = await checkEligibility(client, guildId, user.id);
  if (!check.ok) {
    await ephemeral(interaction, errorEmbed({ title: 'Appeal Unavailable', description: check.message }));
    return;
  }

  const wait = cooldownRemaining(guildId, user.id);
  if (wait > 0) {
    await ephemeral(interaction, errorEmbed({
      title: 'Appeal Already Sent',
      description: 'You sent an appeal recently. Wait for staff to respond before sending another.',
    }));
    return;
  }

  const text = sanitizeReason(interaction.fields.getTextInputValue('reason'), { maxLength: MAX_APPEAL_LENGTH, fallback: '' });
  if (!text) {
    await ephemeral(interaction, errorEmbed({ title: 'Appeal Empty', description: 'Write a reason for your appeal and submit again.' }));
    return;
  }

  const channel = await client.channels.fetch(check.channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    await ephemeral(interaction, errorEmbed({
      title: 'Appeal Not Sent',
      description: 'The appeals channel is not available right now. Try again later.',
    }));
    return;
  }

  const embed = baseEmbed({
    title: 'Ban Appeal',
    color: COLORS.info,
    fields: [
      { name: 'Member', value: `${user.tag}\n${user.id}`, inline: true },
      { name: 'Submitted', value: `<t:${Math.floor(Date.now() / 1000)}:f>`, inline: true },
      { name: 'Appeal', value: text.slice(0, 1024), inline: false },
    ],
    thumbnail: user.displayAvatarURL({ size: 128 }),
    footer: `${check.guild.name} | Appeal from ${user.id}`,
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`appeal:approve:${guildId}:${user.id}`).setLabel('Approve (unban)').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`appeal:deny:${guildId}:${user.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
  );

  const sent = await channel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } }).catch(() => null);
  if (!sent) {
    await ephemeral(interaction, errorEmbed({ title: 'Appeal Not Sent', description: 'The appeal could not be posted. Try again later.' }));
    return;
  }

  recentSubmissions.set(`${guildId}:${user.id}`, Date.now());
  await ephemeral(interaction, successEmbed({
    title: 'Appeal Sent',
    description: 'Staff will review your appeal. If your direct messages are open, you will get a message with the decision.',
  }));
}

/** Staff pressed Approve or Deny on an appeal. */
async function decide(client, deps, interaction, action, guildId, userId) {
  if (!interaction.inGuild() || interaction.guild.id !== guildId) {
    await ephemeral(interaction, errorEmbed({ title: 'Wrong Server', description: 'Use the buttons in the server where the appeal was posted.' }));
    return;
  }

  const config = (await repo('guilds').getConfig(guildId).catch(() => null)) || {};
  const ownerIds = deps && deps.appConfig ? deps.appConfig.discord.ownerIds : [];
  const gate = permissionService.canRunCommand({
    member: interaction.member,
    config,
    command: { permission: 'moderator' },
    ownerIds,
  });
  if (!gate.allowed) {
    await ephemeral(interaction, errorEmbed({ title: 'Not Allowed', description: 'Deciding appeals needs moderator level or higher.' }));
    return;
  }

  // Acknowledge first: the unban and DMs can take longer than three seconds.
  await interaction.deferUpdate().catch(() => null);

  const guild = interaction.guild;
  const staff = interaction.member;
  const user = await client.users.fetch(userId).catch(() => null);
  let outcome;

  if (!user) {
    outcome = 'The member could not be loaded. Nothing was changed.';
  } else if (action === 'approve') {
    const ban = await guild.bans.fetch(userId).catch(() => null);
    if (!ban) {
      outcome = 'There is no active ban for this member, so nothing was changed.';
    } else {
      // Required lazily: punishmentService loads this module at startup.
      const punishmentService = require('./punishmentService');
      // The result DM is part of the appeal itself, so it is sent even when the
      // server has punishment DMs turned off.
      const result = await punishmentService.unban(
        { guild, config: { ...config, dmOnPunishment: true }, moderator: staff },
        user,
        { reason: `Ban appeal approved by ${staff.user.tag}` },
      );
      outcome = `Approved by ${staff.user.tag}. Unbanned (case #${result.caseNumber}). Decision DM: ${describeDm(result.dmDelivered)}.`;
    }
  } else {
    const delivered = await user.send({
      embeds: [baseEmbed({
        title: `Your appeal to ${guild.name} was denied`,
        description: 'The server staff reviewed your ban appeal and decided to keep the ban in place.',
        color: COLORS.ban,
        footer: guild.name,
      })],
    }).then(() => true).catch(() => false);
    outcome = `Denied by ${staff.user.tag}. Decision DM: ${delivered ? 'delivered' : 'not delivered'}.`;
    log.info('Ban appeal denied', { guildId, userId, by: staff.id });
  }

  const original = interaction.message.embeds[0];
  const updated = original ? EmbedBuilder.from(original) : new EmbedBuilder().setTitle('Ban Appeal');
  updated.addFields({ name: 'Decision', value: outcome.slice(0, 1024), inline: false });
  await interaction.message.edit({ embeds: [updated], components: [] }).catch(() => null);
}

/** Human text for a DM delivery result. */
function describeDm(delivered) {
  if (delivered === null || delivered === undefined) return 'not attempted';
  return delivered ? 'delivered' : 'not delivered';
}

module.exports = {
  readAppeals,
  appealsOpen,
  sendBanNotice,
  handleInteraction,
  checkEligibility,
  // Exposed for tests.
  _recentSubmissions: recentSubmissions,
  APPEAL_COOLDOWN_MS,
};
