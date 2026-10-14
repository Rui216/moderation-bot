'use strict';

/**
 * The moderation pipeline.
 *
 * Every punishable action in this bot flows through applyAction so that the
 * behaviour is identical everywhere:
 *
 *   1. Validate the action against the guild configuration (reason required).
 *   2. Enforce role hierarchy where a member target is involved.
 *   3. Execute the Discord API call supplied by the caller.
 *   4. Persist a case with its optional warning row, punishment state, and
 *      scheduled expiry task (all in one gateway request).
 *   5. Optionally direct message the punished member.
 *   6. Emit the moderation log entry.
 *   7. Return the embed the command replies with.
 *
 * Callers therefore never hand-build embeds, never write their own case rows,
 * and cannot forget to log.
 */

const { ACTIONS, MESSAGES, TASK_TYPES } = require('../config/constants');
const { moderationEmbed } = require('../utils/embeds');
const { UserError, ValidationError, DiscordActionError, HierarchyError, safeErrorMessage } = require('../utils/errors');
const { sanitizeReason } = require('../utils/sanitize');
const { formatDuration, formatAbsolute } = require('../utils/duration');
const { logger } = require('../utils/logger');
const { repo } = require('../db');

const hierarchyService = require('./hierarchyService');
const dmService = require('./dmService');
const loggingService = require('./loggingService');

const log = logger.child('moderation');

/**
 * Translate a discord.js error into something a moderator can act on, without
 * leaking internals.
 * @param {Error} error
 * @param {string} action
 * @returns {Error}
 */
function classifyDiscordError(error, action) {
  const code = error && error.code;
  if (code === 50013) {
    return new HierarchyError(
      'Discord rejected the action because the bot lacks the required permission. Check the bot role position and permissions.',
      { details: { action, code } },
    );
  }
  if (code === 10013 || code === 10007) {
    return new ValidationError('That user or member could not be found.', { details: { action, code } });
  }
  if (code === 50035) {
    return new ValidationError('Discord rejected the request parameters.', { details: { action, code } });
  }
  return new DiscordActionError(`Discord action failed: ${action}`, {
    details: { action, code },
    userMessage: MESSAGES.genericError,
  });
}

/**
 * Execute a moderation action end to end.
 *
 * @param {object} options
 * @param {import('discord.js').Guild} options.guild
 * @param {object} options.config              guild configuration document
 * @param {import('discord.js').GuildMember} [options.moderator] acting member (omit for system actions)
 * @param {*} [options.target]                 member, user, or null
 * @param {string} options.action              action key from ACTIONS
 * @param {string} [options.reason]
 * @param {string} [options.evidenceUrl]
 * @param {number} [options.durationMs]
 * @param {number} [options.expiresAt]
 * @param {string} [options.channelId]
 * @param {object} [options.metadata]
 * @param {() => Promise<any>} [options.perform] Discord API call for this action
 * @param {boolean} [options.guardTarget]      run hierarchy checks against a member target
 * @param {{expiresAt: number|null}} [options.warning]
 * @param {{type: string, roleId?: string|null, expiresAt?: number|null}} [options.punishment]
 * @param {{type: string, runAt: number, payload?: object}} [options.task]
 * @param {boolean} [options.dm]               send a punishment DM
 * @param {boolean} [options.logEvent]         emit the mod_action log entry
 * @param {string} [options.logEventKey]       override the log event key
 * @param {Array} [options.extraFields]
 * @param {string} [options.title]
 * @param {string} [options.description]
 * @param {string} [options.footer]
 * @returns {Promise<{caseNumber: number|null, case: object|null, embed: object, dmDelivered: boolean|null}>}
 */
async function applyAction(options) {
  const {
    guild,
    config,
    moderator = null,
    target = null,
    action,
    reason: rawReason,
    evidenceUrl = null,
    durationMs = null,
    expiresAt = null,
    channelId = null,
    metadata = {},
    perform = null,
    guardTarget = false,
    warning = null,
    punishment = null,
    task = null,
    dm = false,
    logEvent = true,
    logEventKey = 'mod_action',
    extraFields = null,
    title = null,
    description = null,
    footer = null,
    systemActor = 'system',
  } = options;

  if (!ACTIONS[action]) {
    throw new ValidationError('That action is not recognized.', { code: 'UNKNOWN_ACTION' });
  }

  // 1. Reason policy. Required when the guild has not opted out.
  const requiresReason = config ? config.requireReason !== false : true;
  const reason = sanitizeReason(rawReason, {
    maxLength: 500,
    fallback: requiresReason ? '' : 'No reason provided',
  });
  if (requiresReason && !reason) {
    throw new ValidationError('A reason is required for this action in this server.', { code: 'REASON_REQUIRED' });
  }

  // 2. Hierarchy. Only meaningful when both parties are members.
  if (guardTarget && target && target.roles) {
    hierarchyService.assertCanActOn(moderator, target);
  }

  // 3. Perform the Discord call.
  if (typeof perform === 'function') {
    try {
      await perform();
    } catch (error) {
      log.warn('Moderation action failed', { guildId: guild.id, action, code: error && error.code });
      throw classifyDiscordError(error, action);
    }
  }

  const moderatorId = moderator ? moderator.id : systemActor;

  // 4. Persist the case and any side effects in one request.
  let caseNumber = null;
  let caseDoc = null;
  try {
    const result = await repo('cases').create(guild.id, {
      action,
      targetId: target ? target.id : null,
      moderatorId,
      reason: reason || null,
      evidenceUrl,
      durationMs: durationMs || null,
      expiresAt: expiresAt || null,
      channelId,
      metadata,
      warning: warning ? { expiresAt: warning.expiresAt ?? null } : null,
      punishment,
      task,
    });
    caseNumber = result.caseNumber;
    caseDoc = result.case;
  } catch (error) {
    // The Discord action already happened: report the storage failure loudly
    // in logs but still return an embed so the moderator is not left guessing.
    log.error('Failed to persist moderation case', {
      guildId: guild.id,
      action,
      code: error && error.code,
      message: error && error.message,
    });
    if (typeof perform === 'function') {
      throw new UserError('The Discord action was applied, but its case and any automatic expiry could not be saved. Do not blindly repeat the command. Check the member and restore storage; temporary bans or roles may need to be reversed manually.', { code: 'ACTION_APPLIED_STORAGE_FAILED' });
    }
    throw error;
  }

  // 5. Direct message the punished member.
  let dmDelivered = null;
  if (dm && target && config && config.dmOnPunishment !== false) {
    try {
      const user = target.user || target;
      const embed = dmService.buildPunishmentDm({
        action,
        guild,
        reason: reason || 'No reason provided',
        caseId: caseNumber,
        durationMs: durationMs || null,
        expiresAtMs: expiresAt || null,
      });
      const result = await dmService.sendPunishmentDm({ user, embed });
      dmDelivered = result.delivered;
    } catch (error) {
      log.debug('Punishment DM failed', { guildId: guild.id, action });
      dmDelivered = false;
    }
  }

  // 6. Reply embed, always built from the shared template.
  const embed = moderationEmbed({
    action,
    target: target || undefined,
    moderator: moderator || undefined,
    reason: reason || (requiresReason ? 'Not provided' : 'No reason provided'),
    caseId: caseNumber,
    durationMs: durationMs || undefined,
    expiresAtMs: expiresAt || undefined,
    extraFields,
    title: title || undefined,
    description: description || undefined,
    footer: footer || undefined,
    guildName: guild.name,
  });

  // 7. Moderation log entry.
  if (logEvent) {
    const fields = [];
    if (caseNumber) fields.push({ name: 'Case ID', value: `#${caseNumber}`, inline: true });
    if (moderator) fields.push({ name: 'Moderator', value: `${moderator.user ? moderator.user.tag : moderator.id}`, inline: true });
    if (target) fields.push({ name: 'Target', value: `${target.user ? target.user.tag : target.id}`, inline: true });
    if (Number.isFinite(durationMs) && durationMs > 0) {
      fields.push({ name: 'Duration', value: formatDuration(durationMs), inline: true });
    }
    if (Number.isFinite(expiresAt)) {
      fields.push({ name: 'Expires', value: formatAbsolute(expiresAt), inline: true });
    }
    fields.push({ name: 'Reason', value: reason || 'No reason provided', inline: false });
    if (evidenceUrl) fields.push({ name: 'Evidence', value: evidenceUrl, inline: false });

    await loggingService.emit(guild, logEventKey, {
      title: `Case #${caseNumber} - ${ACTIONS[action].title}`,
      description: description || undefined,
      fields,
      thumbnail: target && target.displayAvatarURL ? target.displayAvatarURL({ size: 128 }) : undefined,
      footer: `${guild.name} | Case #${caseNumber}`,
    });
  }

  return { caseNumber, case: caseDoc, embed, dmDelivered };
}

/**
 * Record an action that did not go through applyAction (automod decisions,
 * raid protection, expiry completions). Keeps logging and case creation in one
 * place for system-generated events.
 *
 * @param {object} options
 * @param {import('discord.js').Guild} options.guild
 * @param {string} options.action
 * @param {*} [options.target]
 * @param {string} [options.moderatorId] defaults to "system"
 * @param {string} [options.reason]
 * @param {object} [options.metadata]
 * @param {Array} [options.fields] fields for the log embed
 * @param {string} [options.title]
 * @param {string} [options.description]
 * @param {string} [options.logEventKey]
 * @returns {Promise<{caseNumber: number|null}>}
 */
async function recordSystemAction(options) {
  const {
    guild,
    action,
    target = null,
    moderatorId = 'system',
    reason = null,
    metadata = {},
    fields = [],
    title = null,
    description = null,
    logEventKey = 'mod_action',
    warning = null,
    punishment = null,
    task = null,
    channelId = null,
  } = options;

  const result = await repo('cases').create(guild.id, {
    action,
    targetId: target ? target.id : null,
    moderatorId,
    reason: reason ? sanitizeReason(reason, { maxLength: 500 }) : null,
    channelId,
    metadata,
    warning,
    punishment,
    task,
  });

  await loggingService.emit(guild, logEventKey, {
    title: title || `Case #${result.caseNumber} - ${(ACTIONS[action] || { title: 'Moderation Action' }).title}`,
    description,
    fields: [
      { name: 'Case ID', value: `#${result.caseNumber}`, inline: true },
      ...(target ? [{ name: 'Target', value: `${target.user ? target.user.tag : target.id}`, inline: true }] : []),
      ...fields,
    ],
    thumbnail: target && target.displayAvatarURL ? target.displayAvatarURL({ size: 128 }) : undefined,
    footer: `${guild.name} | Case #${result.caseNumber}`,
  });

  return { caseNumber: result.caseNumber, case: result.case };
}

/** Convenience wrapper used by commands to build task payloads. */
function buildExpiryTask(type, targetId, runAt, payload = {}) {
  return { type, targetId, runAt, payload };
}

module.exports = {
  applyAction,
  recordSystemAction,
  buildExpiryTask,
  classifyDiscordError,
  TASK_TYPES,
  safeErrorMessage,
};
