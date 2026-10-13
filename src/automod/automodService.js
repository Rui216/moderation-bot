'use strict';

/**
 * Automod service: rule evaluation plus the enforcement pipeline.
 *
 * Enforcement model:
 *   1. Rules are evaluated against message content (see rules.js).
 *   2. The first matching rule with a punishment other than "none" is applied.
 *   3. Every violation records weighted strikes in D1 with a rolling window.
 *   4. If the new strike total lands exactly on an escalation step, that step's
 *      punishment is applied instead of the per-rule punishment.
 *
 * There is intentionally no flood or rate detection here: repeat offenders are
 * handled by the strike ladder and by staff, not by timing heuristics.
 *
 * Everything the service does is best-effort: a failure while deleting a
 * message or recording a strike must never break message handling.
 */

const { PermissionFlagsBits } = require('discord.js');

const { AUTOMOD_RULES, COLORS } = require('../config/constants');
const { baseEmbed } = require('../utils/embeds');
const { parseDuration, formatDuration } = require('../utils/duration');
const { logger } = require('../utils/logger');
const { cleanText } = require('../utils/sanitize');
const { repo } = require('../db');
const { evaluateRule, redactLinks } = require('./rules');
const permissionService = require('../services/permissionService');
const loggingService = require('../services/loggingService');
const punishmentService = require('../services/punishmentService');

const log = logger.child('automod');

/** Recently processed message ids, so a rule can never fire twice per message. */
const processed = new Set();
const PROCESSED_LIMIT = 5000;

/** Default durations for rule punishments that need one. */
const RULE_PUNISHMENT_DURATIONS = {
  mute: 10 * 60 * 1000,
  tempmute: 60 * 60 * 1000,
  tempban: 24 * 60 * 60 * 1000,
};

function remember(messageId) {
  if (processed.has(messageId)) return false;
  processed.add(messageId);
  if (processed.size > PROCESSED_LIMIT) {
    const iterator = processed.values();
    for (let index = 0; index < 500; index += 1) {
      const next = iterator.next();
      if (next.done) break;
      processed.delete(next.value);
    }
  }
  return true;
}

/**
 * Decide whether a message is exempt from automod entirely.
 *
 * @param {import('discord.js').Message} message
 * @param {object} automod automod configuration document
 * @param {object} config guild configuration document
 * @param {object} appConfig environment configuration
 * @returns {string|null} exemption reason, or null to evaluate rules
 */
function exemptionReason(message, automod, config, appConfig) {
  const exemptions = automod.exemptions || {};

  if (!message.guild || !message.member) return 'not-in-guild';
  if (message.system) return 'system-message';
  if (message.author.bot && exemptions.ignoreBots !== false) return 'bot';
  if (message.webhookId) return 'webhook';

  if (Array.isArray(exemptions.channelIds) && exemptions.channelIds.includes(message.channel.id)) return 'exempt-channel';
  if (Array.isArray(exemptions.roleIds) && message.member.roles.cache.size > 0) {
    if (exemptions.roleIds.some((roleId) => message.member.roles.cache.has(roleId))) return 'exempt-role';
  }

  if (exemptions.ignoreStaff !== false) {
    const ownerIds = appConfig && appConfig.discord ? appConfig.discord.ownerIds : [];
    if (permissionService.isStaff(message.member, config, ownerIds)) return 'staff';
  }

  if (message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return 'manage-messages';

  return null;
}

/**
 * Handle a message: evaluate every enabled rule and enforce the outcome.
 *
 * @param {import('discord.js').Message} message
 * @param {object} context
 * @param {object} context.config guild configuration document
 * @param {object} context.automod automod configuration document
 * @param {object} context.appConfig environment configuration
 * @returns {Promise<{handled: boolean, rule?: string, reason?: string}>}
 */
async function handleMessage(message, context) {
  const { config, automod, appConfig } = context;

  if (!automod || automod.enabled === false) return { handled: false, reason: 'disabled' };
  if (!message.content || message.content.length === 0) return { handled: false, reason: 'empty' };

  const exempt = exemptionReason(message, automod, config, appConfig);
  if (exempt) return { handled: false, reason: exempt };

  if (!remember(message.id)) return { handled: false, reason: 'already-processed' };

  const violations = [];
  for (const rule of AUTOMOD_RULES) {
    const ruleConfig = (automod.rules || {})[rule];
    if (!ruleConfig || ruleConfig.enabled !== true) continue;
    if (ruleConfig.punishment === 'none') continue;

    try {
      const violation = evaluateRule(rule, {
        content: message.content,
        message,
        ruleConfig,
        automod,
      });
      if (violation) violations.push({ ...violation, punishment: ruleConfig.punishment, weight: ruleConfig.strikeWeight ?? 1 });
    } catch (error) {
      log.debug('Rule evaluation failed', { rule, code: error && error.code });
    }
  }

  if (violations.length === 0) return { handled: false };

  const primary = violations[0];

  try {
    await enforce(message, context, violations, primary);
  } catch (error) {
    log.warn('Automod enforcement failed', {
      guildId: message.guild.id,
      rule: primary.rule,
      code: error && error.code,
    });
    return { handled: false, rule: primary.rule, reason: 'enforcement-failed' };
  }

  return { handled: true, rule: primary.rule };
}

/**
 * Apply the enforcement outcome for a set of violations.
 */
async function enforce(message, context, violations, primary) {
  const { config, automod } = context;
  const guild = message.guild;
  const member = message.member;

  // 1. Remove the message for content rules. Deleting is the safe default and
  //    is also what "delete" and every punishment implies.
  let deleted = false;
  if (message.deletable) {
    deleted = await message.delete().then(() => true).catch(() => false);
  }

  // 2. Record strikes and read back the new active total.
  const escalation = automod.escalation || {};
  const windowHours = Number.isFinite(escalation.windowHours) ? escalation.windowHours : 24;
  const weight = violations.reduce((total, violation) => total + (Number(violation.weight) || 0), 0);

  let strikeTotal = 0;
  try {
    const result = await repo('punishments').addStrike(guild.id, {
      userId: member.id,
      rule: primary.rule,
      weight: weight || 1,
      windowHours,
      reason: primary.detail,
      channelId: message.channel.id,
      messageId: message.id,
    });
    strikeTotal = result.strikes;
  } catch (error) {
    log.debug('Strike recording failed', { code: error && error.code });
  }

  // 3. Pick the punishment: an escalation step that was just reached wins,
  //    otherwise the rule's own configured punishment applies.
  let punishment = primary.punishment;
  let escalationStep = null;

  if (escalation.enabled !== false && Array.isArray(escalation.steps) && strikeTotal > 0) {
    escalationStep = escalation.steps.find((step) => step.strikes === strikeTotal) || null;
    if (escalationStep && escalationStep.action && escalationStep.action !== 'none') {
      punishment = escalationStep.action;
    }
  }

  // 4. Log the trigger for staff.
  const triggerFields = [
    { name: 'Member', value: `${message.author.tag} (${message.author.id})`, inline: true },
    { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
    { name: 'Rule', value: primary.rule, inline: true },
    { name: 'Detail', value: primary.detail, inline: true },
    { name: 'Strikes', value: String(strikeTotal), inline: true },
    { name: 'Message Removed', value: deleted ? 'Yes' : 'No', inline: true },
    { name: 'Message Content', value: cleanText(redactLinks(message.content), 900) || '(no text content)', inline: false },
  ];
  if (violations.length > 1) {
    triggerFields.push({
      name: 'Other Rules Matched',
      value: violations.slice(1).map((violation) => violation.rule).join(', '),
      inline: false,
    });
  }
  if (escalationStep) {
    triggerFields.push({ name: 'Escalation Step', value: `${escalationStep.strikes} strikes`, inline: true });
  }

  await loggingService.emit(guild, 'automod_trigger', {
    title: 'Automod Triggered',
    description: `Rule matched: ${primary.rule}`,
    fields: triggerFields,
    thumbnail: message.author.displayAvatarURL({ size: 128 }),
    sourceChannelId: message.channel.id,
  });

  // 5. Apply the punishment. "delete" and "warn" are handled here; the rest
  //    delegate to the punishment service so cases, DMs, and logs are uniform.
  const systemCtx = { guild, config, moderator: null, appConfig: context.appConfig };

  if (punishment === 'none' || punishment === 'delete') {
    if (punishment !== 'delete') return;
    await notifyAuthor(message, primary);
    return;
  }

  if (punishment === 'warn') {
    await notifyAuthor(message, primary);
    await punishmentService.warn(systemCtx, member, {
      reason: `Automod: ${primary.detail}`,
      warningExpiresDays: 0,
    }).catch((error) => log.debug('Automod warn failed', { code: error && error.code }));
    return;
  }

  if (punishment === 'mute' || punishment === 'tempmute') {
    const durationMs = parseEscalationDuration(escalationStep) || RULE_PUNISHMENT_DURATIONS[punishment];
    await punishmentService.mute(systemCtx, member, {
      reason: `Automod: ${primary.detail}`,
      durationMs,
      temporary: true,
    }).catch((error) => log.debug('Automod mute failed', { code: error && error.code }));
    return;
  }

  if (punishment === 'kick') {
    await punishmentService.kick(systemCtx, member, { reason: `Automod: ${primary.detail}` })
      .catch((error) => log.debug('Automod kick failed', { code: error && error.code }));
    return;
  }

  if (punishment === 'ban' || punishment === 'tempban') {
    const durationMs = punishment === 'tempban'
      ? (parseEscalationDuration(escalationStep) || RULE_PUNISHMENT_DURATIONS.tempban)
      : null;
    await punishmentService.ban(systemCtx, member, {
      reason: `Automod: ${primary.detail}`,
      durationMs,
    }).catch((error) => log.debug('Automod ban failed', { code: error && error.code }));
  }
}

/** Parse a step duration string such as "30m" into milliseconds. */
function parseEscalationDuration(step) {
  if (!step || !step.duration) return null;
  const parsed = parseDuration(step.duration, { maxMs: 365 * 24 * 60 * 60 * 1000 });
  return parsed.ok ? parsed.ms : null;
}

/** Best-effort notice to the author so they understand why the message went. */
async function notifyAuthor(message, violation) {
  const note = violation.rule === 'words'
    ? 'Your message contained a blocked word.'
    : `Your message was removed by the ${violation.rule} filter.`;
  await message.author.send({
    embeds: [baseEmbed({
      title: `Message removed in ${message.guild.name}`,
      description: `${note}\nRule: ${violation.rule}`,
      color: COLORS.notice,
      footer: `${message.guild.name} | Automod notice`,
    })],
  }).catch(() => null);
}

/**
 * Apply the escalation ladder for an already-recorded violation. Exposed so
 * commands such as warn can participate in the same ladder if desired.
 *
 * @param {object} ctx command context
 * @param {import('discord.js').GuildMember} member
 * @param {number} strikeTotal
 * @returns {Promise<{action: string, durationMs: number|null}|null>}
 */
async function resolveEscalationStep(ctx, member, strikeTotal) {
  const automod = await repo('guilds').getAutomod(ctx.guild.id);
  const escalation = automod.escalation || {};
  if (escalation.enabled === false) return null;

  const step = (escalation.steps || []).find((entry) => entry.strikes === strikeTotal);
  if (!step) return null;

  return {
    action: step.action,
    durationMs: parseEscalationDuration(step),
    label: `${step.strikes} strikes -> ${step.action}${step.duration ? ` (${formatDuration(parseEscalationDuration(step) || 0)})` : ''}`,
  };
}

module.exports = {
  handleMessage,
  resolveEscalationStep,
  exemptionReason,
  parseEscalationDuration,
  RULE_PUNISHMENT_DURATIONS,
};
