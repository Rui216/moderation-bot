'use strict';

/**
 * Argument parsing and entity resolution for prefix commands.
 *
 * Prefix commands receive raw text, so every command resolves its own
 * arguments through these helpers. Resolution order for a user argument is:
 * mention, raw snowflake, username, display name, nickname - all matched
 * case-insensitively, with an exact match preferred over a partial one.
 *
 * No helper performs a destructive action; they only resolve and return
 * objects or null, leaving validation messages to the caller.
 */

const { cleanText } = require('./sanitize');

/** Discord user mention: <@123> or <@!123>. */
const USER_MENTION = /^<@!?(\d{17,20})>$/;
const ROLE_MENTION = /^<@&(\d{17,20})>$/;
const CHANNEL_MENTION = /^<#(\d{17,20})>$/;

/**
 * Split a raw argument string into tokens, honouring double quoted segments.
 * @param {string} input
 * @returns {string[]}
 */
function tokenize(input) {
  const tokens = [];
  let current = '';
  let quoted = false;

  for (const character of String(input || '').trim()) {
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(character)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Separate leading flags (--key or --key=value) from positional arguments.
 * Flags may appear anywhere; they are removed from the positional list.
 * @param {string[]} tokens
 * @returns {{flags: Record<string, string|boolean>, args: string[]}}
 */
function extractFlags(tokens) {
  const flags = {};
  const args = [];

  for (const token of tokens) {
    if (/^--[a-z][a-z0-9-]*(=.*)?$/i.test(token)) {
      const [key, value] = token.slice(2).split('=');
      flags[key.toLowerCase()] = value === undefined ? true : value;
      continue;
    }
    args.push(token);
  }
  return { flags, args };
}

/**
 * Resolve a member from a mention, id, username, display name, or nickname.
 * @param {import('discord.js').Guild} guild
 * @param {string} query
 * @returns {Promise<import('discord.js').GuildMember|null>}
 */
async function resolveMember(guild, query) {
  if (!guild || !query) return null;
  const text = String(query).trim();

  const mentionMatch = USER_MENTION.exec(text);
  if (mentionMatch) {
    return guild.members.fetch(mentionMatch[1]).catch(() => null);
  }

  if (/^\d{17,20}$/.test(text)) {
    const byId = await guild.members.fetch(text).catch(() => null);
    if (byId) return byId;
  }

  const needle = text.toLowerCase().replace(/^@/, '');
  if (!needle) return null;

  const cached = guild.members.cache;

  // Prefer an exact match on any of the identifying fields.
  const exact = cached.find((member) => (
    member.user.username.toLowerCase() === needle
    || (member.user.globalName && member.user.globalName.toLowerCase() === needle)
    || (member.nickname && member.nickname.toLowerCase() === needle)
    || `${member.user.username}`.toLowerCase() === needle
  ));
  if (exact) return exact;

  // Fall back to a prefix match, and only then a substring match.
  const prefix = cached.find((member) => (
    member.user.username.toLowerCase().startsWith(needle)
    || (member.user.globalName && member.user.globalName.toLowerCase().startsWith(needle))
    || (member.nickname && member.nickname.toLowerCase().startsWith(needle))
  ));
  if (prefix) return prefix;

  return cached.find((member) => (
    member.user.username.toLowerCase().includes(needle)
    || (member.user.globalName && member.user.globalName.toLowerCase().includes(needle))
    || (member.nickname && member.nickname.toLowerCase().includes(needle))
  )) || null;
}

/**
 * Resolve a user, including people who are not currently in the guild
 * (needed for unban and for looking up history).
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').Guild} guild
 * @param {string} query
 * @returns {Promise<import('discord.js').User|null>}
 */
async function resolveUser(client, guild, query) {
  if (!query) return null;
  const text = String(query).trim();

  const mentionMatch = USER_MENTION.exec(text);
  if (mentionMatch) {
    return client.users.fetch(mentionMatch[1]).catch(() => null);
  }

  if (/^\d{17,20}$/.test(text)) {
    const user = await client.users.fetch(text).catch(() => null);
    if (user) return user;
  }

  const member = guild ? await resolveMember(guild, text) : null;
  if (member) return member.user;

  const needle = text.toLowerCase().replace(/^@/, '');
  const cached = client.users.cache.find((user) => (
    user.username.toLowerCase() === needle
    || (user.globalName && user.globalName.toLowerCase() === needle)
  ));
  return cached || null;
}

/**
 * Resolve a role by mention, id, or name.
 * @param {import('discord.js').Guild} guild
 * @param {string} query
 * @returns {Promise<import('discord.js').Role|null>}
 */
async function resolveRole(guild, query) {
  if (!guild || !query) return null;
  const text = String(query).trim();

  const mentionMatch = ROLE_MENTION.exec(text);
  if (mentionMatch) return guild.roles.fetch(mentionMatch[1]).catch(() => null);

  if (/^\d{17,20}$/.test(text)) {
    const role = await guild.roles.fetch(text).catch(() => null);
    if (role) return role;
  }

  const needle = text.toLowerCase().replace(/^@/, '');
  if (!needle) return null;

  return guild.roles.cache.find((role) => role.name.toLowerCase() === needle)
    || guild.roles.cache.find((role) => role.name.toLowerCase().startsWith(needle))
    || null;
}

/**
 * Resolve a channel by mention, id, or name.
 * @param {import('discord.js').Guild} guild
 * @param {string} query
 * @returns {Promise<import('discord.js').GuildBasedChannel|null>}
 */
async function resolveChannel(guild, query) {
  if (!guild || !query) return null;
  const text = String(query).trim();

  const mentionMatch = CHANNEL_MENTION.exec(text);
  if (mentionMatch) return guild.channels.fetch(mentionMatch[1]).catch(() => null);

  if (/^\d{17,20}$/.test(text)) {
    const channel = await guild.channels.fetch(text).catch(() => null);
    if (channel) return channel;
  }

  const needle = text.toLowerCase().replace(/^#/, '');
  if (!needle) return null;

  return guild.channels.cache.find((channel) => channel.name.toLowerCase() === needle)
    || guild.channels.cache.find((channel) => channel.name.toLowerCase().startsWith(needle))
    || null;
}

/**
 * Join the remaining tokens into a reason string.
 * @param {string[]} tokens
 * @returns {string}
 */
function joinReason(tokens) {
  return cleanText(tokens.join(' '), 500);
}

/**
 * Parse "amount" style arguments with a bound applied by the caller.
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function parseCount(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

module.exports = {
  tokenize,
  extractFlags,
  resolveMember,
  resolveUser,
  resolveRole,
  resolveChannel,
  joinReason,
  parseCount,
  USER_MENTION,
  ROLE_MENTION,
  CHANNEL_MENTION,
};
