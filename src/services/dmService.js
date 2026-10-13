'use strict';

/**
 * Direct message notifications for punished members.
 *
 * Behaviour:
 *   - Sends an embed matching the bot's styling for warns, mutes, kicks, bans.
 *   - Runs through a small queue so a burst of actions cannot exhaust the
 *     gateway rate limit.
 *   - Degrades gracefully: if the member has DMs closed the failure is
 *     swallowed and recorded in the case metadata, never surfaced as an error.
 *   - Never includes internal identifiers, worker URLs, or moderator notes.
 */

const { moderationEmbed } = require('../utils/embeds');
const { logger } = require('../utils/logger');
const { ACTIONS } = require('../config/constants');

const log = logger.child('dm');

/** Simple sequential queue with a delay between sends. */
const queue = [];
let draining = false;

/** Milliseconds between DM sends to stay comfortably inside rate limits. */
const SEND_INTERVAL_MS = 350;

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift();
      try {
        await job();
      } catch {
        // Individual failures are handled inside the job.
      }
      if (queue.length > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, SEND_INTERVAL_MS);
        });
      }
    }
  } finally {
    draining = false;
  }
}

/**
 * Build the DM embed for a punishment.
 *
 * @param {object} options
 * @param {string} options.action action key
 * @param {import('discord.js').Guild} options.guild
 * @param {string} options.reason
 * @param {number|string} options.caseId
 * @param {number} [options.durationMs]
 * @param {number} [options.expiresAtMs]
 * @param {string} [options.extra]
 * @returns {object} embed payload
 */
function buildPunishmentDm(options) {
  const meta = ACTIONS[options.action] || { title: 'Moderation Action' };

  const notes = {
    warn: 'This warning is recorded on your moderation history. Repeated warnings may lead to a mute, kick, or ban.',
    mute: 'You cannot send messages or join voice channels until the mute expires.',
    tempmute: 'You cannot send messages or join voice channels until the mute expires.',
    kick: 'You may rejoin the server, but repeat behaviour can lead to a ban.',
    ban: 'You have been removed from the server.',
    tempban: 'You have been temporarily removed from the server.',
    softban: 'You have been removed from the server and recent messages were cleared.',
  };

  return moderationEmbed({
    action: options.action,
    title: `You were ${meta.title.replace('Member ', '').toLowerCase()} in ${options.guild.name}`,
    description: notes[options.action] || 'A moderation action was applied to your account.',
    reason: options.reason,
    caseId: options.caseId,
    durationMs: options.durationMs,
    expiresAtMs: options.expiresAtMs,
    guildName: options.guild.name,
    moderator: undefined,
    target: undefined,
    extraFields: options.extra
      ? [{ name: 'Details', value: options.extra, inline: false }]
      : undefined,
    footer: `${options.guild.name} | Case #${options.caseId}`,
  });
}

/**
 * Queue a punishment DM.
 *
 * @param {object} options
 * @param {import('discord.js').User} options.user
 * @param {object} embed
 * @returns {Promise<{delivered: boolean, reason?: string}>} resolves when sent
 */
function sendPunishmentDm({ user, embed }) {
  return new Promise((resolve) => {
    queue.push(async () => {
      try {
        await user.send({ embeds: [embed] });
        resolve({ delivered: true });
      } catch (error) {
        // 50007: cannot send messages to this user (DMs closed).
        const code = error && error.code ? error.code : 'unknown';
        log.debug('Punishment DM not delivered', { reason: code });
        resolve({ delivered: false, reason: code === 50007 ? 'dms-closed' : 'failed' });
      }
    });
    void drain();
  });
}

/** Queue depth, exposed for diagnostics. */
function queueDepth() {
  return queue.length;
}

module.exports = { sendPunishmentDm, buildPunishmentDm, queueDepth };
