'use strict';

/**
 * Argument helpers shared by command implementations.
 *
 * These keep the command files focused on intent rather than string surgery:
 * resolving a target, separating a leading duration from the reason, and
 * applying the guild's reason policy consistently.
 */

const { ValidationError } = require('./errors');
const { parseDuration } = require('./duration');
const { sanitizeReason } = require('./sanitize');
const parser = require('./parser');

/** Matches a token that starts with a duration expression, e.g. "10m", "2h". */
const DURATION_TOKEN = /^\d+(?:\.\d+)?\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/i;

/**
 * Resolve the member named by the first argument.
 *
 * @param {object} ctx command context
 * @param {{index?: number, required?: boolean, allowUserFallback?: boolean}} [options]
 * @returns {Promise<import('discord.js').GuildMember|null>}
 * @throws {ValidationError} when required and unresolvable
 */
async function resolveMember(ctx, options = {}) {
  const { index = 0, required = true } = options;
  const query = ctx.args[index];
  if (!query) {
    if (required) throw new ValidationError('Provide a member to act on. Mention them or use their user id.');
    return null;
  }

  const member = await parser.resolveMember(ctx.guild, query);
  if (!member && required) {
    throw new ValidationError('That member could not be found in this server.');
  }
  return member;
}

/**
 * Resolve a user, including people who are not currently a member (unban).
 * @param {object} ctx
 * @param {{index?: number, required?: boolean}} [options]
 */
async function resolveUser(ctx, options = {}) {
  const { index = 0, required = true } = options;
  const query = ctx.args[index];
  if (!query) {
    if (required) throw new ValidationError('Provide a user. Mention them or use their user id.');
    return null;
  }

  const user = await parser.resolveUser(ctx.client, ctx.guild, query);
  if (!user && required) {
    throw new ValidationError('That user could not be found. A raw user id works for people who left the server.');
  }
  return user;
}

/**
 * Resolve a role named by the argument at the given index.
 * @param {object} ctx
 * @param {{index?: number, required?: boolean}} [options]
 */
async function resolveRoleArg(ctx, options = {}) {
  const { index = 1, required = true } = options;
  const query = ctx.args[index];
  if (!query) {
    if (required) throw new ValidationError('Provide a role. Mention it or use its name.');
    return null;
  }
  const role = await parser.resolveRole(ctx.guild, query);
  if (!role && required) throw new ValidationError('That role could not be found.');
  return role;
}

/**
 * Resolve a channel named by the argument at the given index.
 * @param {object} ctx
 * @param {{index?: number, required?: boolean}} [options]
 */
async function resolveChannelArg(ctx, options = {}) {
  const { index = 0, required = false } = options;
  const query = ctx.args[index];
  if (!query) {
    if (required) throw new ValidationError('Provide a channel. Mention it or use its name.');
    return null;
  }
  const channel = await parser.resolveChannel(ctx.guild, query);
  if (!channel && required) throw new ValidationError('That channel could not be found.');
  return channel;
}

/**
 * Pull a leading duration off the token list.
 *
 * Consecutive duration tokens are joined, so "1d 2h reason text" parses as a
 * duration of 1 day 2 hours with "reason text" as the reason.
 *
 * @param {string[]} tokens
 * @param {{maxMs?: number, minMs?: number}} [options]
 * @returns {{durationMs: number|null, rest: string[], invalid?: string}}
 */
function takeDuration(tokens, options = {}) {
  const parts = [];
  let index = 0;

  while (index < tokens.length && DURATION_TOKEN.test(tokens[index])) {
    parts.push(tokens[index]);
    index += 1;
    if (parts.length >= 3) break;
  }

  if (parts.length === 0) return { durationMs: null, rest: tokens };

  const parsed = parseDuration(parts.join(' '), options);
  if (!parsed.ok) {
    return { durationMs: null, rest: tokens, invalid: parsed.reason };
  }
  return { durationMs: parsed.ms, rest: tokens.slice(index) };
}

/**
 * Build the reason string, applying the guild's reason requirement.
 *
 * @param {object} ctx
 * @param {string[]} tokens remaining tokens after target and duration
 * @param {{fallback?: string}} [options]
 * @returns {string}
 * @throws {ValidationError} when a reason is required but absent
 */
function buildReason(ctx, tokens, options = {}) {
  // An empty fallback is deliberate: it is what lets the reason policy below
  // detect "no reason supplied" instead of receiving a placeholder string.
  const reason = sanitizeReason(tokens.join(' '), { maxLength: 500, fallback: '' });
  const required = ctx.config ? ctx.config.requireReason !== false : true;

  if (!reason && required) {
    throw new ValidationError(
      'A reason is required for moderation actions in this server. Add one after the duration.',
      { code: 'REASON_REQUIRED' },
    );
  }

  const finalReason = reason || options.fallback || 'No reason provided';
  // Commands that delegate to services read this value when they need the raw
  // reason string (channel lockdown, purge summaries).
  ctx.rawReason = finalReason;
  return finalReason;
}

/** Throw when a required argument is missing. */
function requireArg(value, message) {
  if (value === undefined || value === null || value === '') throw new ValidationError(message);
  return value;
}

/** Format a list of ids as channel mentions, bounded for embed size. */
function mentionChannels(channelIds, max = 10) {
  const list = (channelIds || []).slice(0, max).map((id) => `<#${id}>`);
  if ((channelIds || []).length > max) list.push(`and ${channelIds.length - max} more`);
  return list.join(', ') || 'None';
}

module.exports = {
  resolveMember,
  resolveUser,
  resolveRoleArg,
  resolveChannelArg,
  takeDuration,
  buildReason,
  requireArg,
  mentionChannels,
  DURATION_TOKEN,
};
