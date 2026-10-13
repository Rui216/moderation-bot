'use strict';

/**
 * Logging dispatcher.
 *
 * Every loggable event in the bot is emitted through this service. Routing is
 * decided per event, not per category:
 *
 *   1. If the event has its own channel override, use it.
 *   2. Otherwise use the channel assigned to the event's default slot.
 *   3. If the event is disabled, or no channel resolves, nothing is sent.
 *
 * Delivery is queued and rate-limit aware: a burst of message deletes cannot
 * cause a flood of failed API calls. All embed content passes through the
 * shared sanitizers, and errors here never propagate to the caller.
 */

const { AuditLogEvent, PermissionFlagsBits } = require('discord.js');

const { LOG_EVENTS, LOG_CATEGORIES } = require('../config/constants');
const { logEmbed } = require('../utils/embeds');
const { logger } = require('../utils/logger');
const { cleanText } = require('../utils/sanitize');
const { repo } = require('../db');

const log = logger.child('logging');

/** Queue of pending log sends, processed sequentially. */
const queue = [];
let draining = false;

/** Minimum gap between sends to the same channel. */
const PER_CHANNEL_INTERVAL_MS = 400;
const lastSendAt = new Map();

/** Environment configuration (internal error channel, etc.). */
let appConfig = null;

/** Bound during startup with the validated environment configuration. */
function configure(config) {
  appConfig = config;
}

/**
 * Resolve the target channel id for an event.
 * @param {object} loggingConfig normalized logging document
 * @param {string} eventKey
 * @returns {string|null}
 */
function resolveChannelId(loggingConfig, eventKey) {
  const meta = LOG_EVENTS[eventKey];
  if (!meta) return null;
  const eventSettings = (loggingConfig.events && loggingConfig.events[eventKey]) || {};
  if (eventSettings.channelId) return eventSettings.channelId;
  const slot = meta.defaultChannel;
  return (loggingConfig.channels && loggingConfig.channels[slot]) || null;
}

/** True when an event should be delivered. */
function isEventEnabled(loggingConfig, eventKey) {
  const meta = LOG_EVENTS[eventKey];
  if (!meta) return false;
  const eventSettings = (loggingConfig.events && loggingConfig.events[eventKey]) || {};
  const enabled = eventSettings.enabled === undefined ? meta.defaultEnabled : Boolean(eventSettings.enabled);
  if (!enabled) return false;
  return Boolean(resolveChannelId(loggingConfig, eventKey));
}

/** Wait until the channel's cooldown has elapsed. */
async function waitForChannel(channelId) {
  const last = lastSendAt.get(channelId) || 0;
  const elapsed = Date.now() - last;
  if (elapsed < PER_CHANNEL_INTERVAL_MS) {
    await new Promise((resolve) => {
      setTimeout(resolve, PER_CHANNEL_INTERVAL_MS - elapsed);
    });
  }
  lastSendAt.set(channelId, Date.now());
}

async function drainQueue() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift();
      try {
        const channel = await job.guild.channels.fetch(job.channelId).catch(() => null);
        if (!channel || !channel.isTextBased || !channel.isTextBased()) continue;

        const me = job.guild.members.me;
        if (me && channel.permissionsFor && !channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) continue;

        await waitForChannel(job.channelId);
        await channel.send({ embeds: [job.embed], allowedMentions: { parse: [] } });
      } catch (error) {
        // Missing permissions or a deleted channel must never break the caller.
        log.debug('Log delivery failed', { event: job.event, code: error && error.code });
      }
    }
  } finally {
    draining = false;
  }
}

/**
 * Emit a log event.
 *
 * @param {import('discord.js').Guild} guild
 * @param {string} eventKey key from LOG_EVENTS
 * @param {object} payload
 * @param {string} payload.title        embed title
 * @param {string} [payload.description]
 * @param {Array} [payload.fields]
 * @param {string} [payload.thumbnail]
 * @param {string} [payload.image]
 * @param {string} [payload.footer]
 * @param {object} [payload.loggingConfig] pre-fetched logging document
 * @param {string} [payload.sourceChannelId] channel the event happened in
 * @returns {Promise<boolean>} true when the event was queued
 */
async function emit(guild, eventKey, payload = {}) {
  try {
    const meta = LOG_EVENTS[eventKey];
    if (!meta) {
      log.debug('Unknown log event ignored', { event: eventKey });
      return false;
    }

    const loggingConfig = payload.loggingConfig || await repo('guilds').getLogging(guild.id);
    if (!isEventEnabled(loggingConfig, eventKey)) return false;

    // Channels in the ignore list produce no message logs at all.
    if (payload.sourceChannelId && Array.isArray(loggingConfig.ignoreChannelIds)) {
      if (loggingConfig.ignoreChannelIds.includes(payload.sourceChannelId)) return false;
    }

    const channelId = resolveChannelId(loggingConfig, eventKey);
    if (!channelId) return false;

    const categoryMeta = LOG_CATEGORIES[meta.category] || { label: 'Event' };

    const embed = logEmbed({
      category: meta.category,
      title: cleanText(payload.title, 200) || meta.label,
      description: payload.description,
      fields: payload.fields,
      thumbnail: payload.thumbnail,
      image: payload.image,
      footer: payload.footer || `${guild.name} | ${categoryMeta.label}`,
      timestamp: true,
    });

    queue.push({ guild, channelId, embed, event: eventKey });
    void drainQueue();
    return true;
  } catch (error) {
    log.debug('Log emit failed', { event: eventKey, code: error && error.code });
    return false;
  }
}

/**
 * Mirror an internal error into the private internal channel configured with
 * LOG_INTERNAL_CHANNEL_ID. Used by the logger hook. The message is already
 * redacted before it reaches this function.
 *
 * @param {import('discord.js').Client} client
 * @param {string} message
 * @param {*} meta
 */
async function sendInternalError(client, message, meta) {
  const channelId = appConfig && appConfig.logging ? appConfig.logging.internalChannelId : null;
  if (!channelId || !client || !client.isReady()) return;

  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased || !channel.isTextBased()) return;

    const stack = meta && meta.stack ? cleanText(meta.stack, 1500) : null;
    const embed = logEmbed({
      category: 'mod',
      title: 'Internal Error',
      description: cleanText(message, 800),
      fields: stack ? [{ name: 'Trace', value: `\`\`\`\n${stack}\n\`\`\``, inline: false }] : undefined,
      footer: 'Internal diagnostics',
    });
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch {
    // Never recurse into error handling from the error path.
  }
}

/**
 * Look up who performed an action in the audit log.
 *
 * Discord only writes audit entries for actions performed by other users or
 * bots, and there can be a short delay. Callers must treat a null result as
 * "unknown", never as "no one did it".
 *
 * @param {import('discord.js').Guild} guild
 * @param {number} auditType AuditLogEvent member
 * @param {{targetId?: string, windowMs?: number, requireNonBot?: boolean}} [options]
 * @returns {Promise<{executorId: string|null, executorTag: string|null, reason: string|null}|null>}
 */
async function findAuditEntry(guild, auditType, options = {}) {
  const { targetId = null, windowMs = 10000, requireNonBot = true } = options;

  const me = guild.members.me;
  if (!me || !me.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;

  try {
    const logs = await guild.fetchAuditLogs({ type: auditType, limit: 6 });
    const cutoff = Date.now() - windowMs;

    for (const entry of logs.entries.values()) {
      if (entry.createdTimestamp < cutoff) continue;
      if (requireNonBot && entry.executorId === guild.client.user.id) continue;
      if (targetId && entry.targetId && entry.targetId !== targetId) continue;
      return {
        executorId: entry.executorId,
        executorTag: entry.executor ? `${entry.executor.username}` : null,
        reason: entry.reason || null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Attribute a message deletion. A MessageDelete audit entry exists when a
 * member with Manage Messages removed the message; self-deletions leave no
 * trace, which the caller should state plainly.
 *
 * @param {import('discord.js').Guild} guild
 * @param {string} channelId
 * @param {number} [windowMs]
 * @returns {Promise<{executorId: string, executorTag: string|null}|null>}
 */
async function findMessageDeleteExecutor(guild, channelId, windowMs = 8000) {
  const entry = await findAuditEntry(guild, AuditLogEvent.MessageDelete, { windowMs, requireNonBot: true });
  if (!entry) return null;
  // The audit entry carries the channel id as an extra field.
  return { executorId: entry.executorId, executorTag: entry.executorTag, channelId };
}

/** Queue depth, exposed for diagnostics and graceful shutdown draining. */
function pending() {
  return queue.length;
}

/**
 * Wait for the queue to empty, up to a timeout. Called during shutdown so the
 * last few log embeds are not lost when the process exits.
 */
async function flush(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while ((queue.length > 0 || draining) && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  return queue.length;
}

module.exports = {
  configure,
  emit,
  findAuditEntry,
  findMessageDeleteExecutor,
  sendInternalError,
  isEventEnabled,
  resolveChannelId,
  pending,
  flush,
};
