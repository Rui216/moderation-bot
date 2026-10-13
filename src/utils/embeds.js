'use strict';

/**
 * Shared embed builder.
 *
 * Every command, log event, wizard screen, and error reply is created through
 * this module so the visual language stays identical everywhere: same colors,
 * same field order, same footer conventions, no emoji.
 *
 * Conventions:
 *   - Title states the action, e.g. "Member Banned".
 *   - Fields are always ordered: Target, Moderator, Reason, Case ID, Duration,
 *     then any command specific extras, then Timestamp last.
 *   - Colors come from config/constants.js COLORS.
 *   - Footers carry the case identifier or the guild name, never internal ids.
 *   - All strings are truncated to Discord's limits before the embed is built,
 *     so no request is ever rejected for length.
 */

const {
  COLORS,
  EMBED_LIMITS,
  ACTIONS,
  MESSAGES,
} = require('../config/constants');
const { cleanText, stripMentions } = require('./sanitize');
const { formatDuration, formatAbsolute } = require('./duration');

/** Truncate a string to a Discord embed limit. */
function clip(value, max) {
  const text = value === null || value === undefined ? '' : String(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

/**
 * Normalize one field, dropping empty values and enforcing limits.
 * @param {{name: string, value: *, inline?: boolean}} field
 */
function normalizeField(field) {
  if (!field || field.value === undefined || field.value === null) return null;
  const value = cleanText(field.value, EMBED_LIMITS.fieldValue);
  if (!value) return null;
  return {
    name: clip(cleanText(field.name, EMBED_LIMITS.fieldName) || 'Details', EMBED_LIMITS.fieldName),
    value: value || '-',
    inline: Boolean(field.inline),
  };
}

/**
 * Base embed factory. Always returns a plain object accepted by discord.js.
 *
 * @param {object} options
 * @param {string} [options.title]
 * @param {string} [options.description]
 * @param {number} [options.color]
 * @param {Array} [options.fields]
 * @param {string} [options.footer]
 * @param {string} [options.author]
 * @param {string} [options.thumbnail]
 * @param {string} [options.image]
 * @param {boolean} [options.timestamp]
 * @returns {object}
 */
function baseEmbed(options = {}) {
  const embed = {};
  const color = Number.isFinite(options.color) ? options.color : COLORS.info;

  embed.color = color;

  if (options.author) {
    embed.author = { name: clip(cleanText(options.author, EMBED_LIMITS.authorName), EMBED_LIMITS.authorName) };
    if (options.authorIcon) embed.author.iconURL = options.authorIcon;
  }

  if (options.title) embed.title = clip(cleanText(options.title, EMBED_LIMITS.title), EMBED_LIMITS.title);

  if (options.description) {
    embed.description = clip(cleanText(options.description, EMBED_LIMITS.description), EMBED_LIMITS.description);
  }

  if (Array.isArray(options.fields)) {
    const fields = options.fields.map(normalizeField).filter(Boolean).slice(0, EMBED_LIMITS.fields);
    if (fields.length > 0) embed.fields = fields;
  }

  if (options.thumbnail) embed.thumbnail = { url: options.thumbnail };
  if (options.image) embed.image = { url: options.image };

  if (options.footer) {
    embed.footer = { text: clip(cleanText(options.footer, EMBED_LIMITS.footer), EMBED_LIMITS.footer) };
  }

  if (options.timestamp !== false) {
    embed.timestamp = new Date(options.timestampMs || Date.now()).toISOString();
  }

  return embed;
}

/**
 * Turn a target into a display string plus thumbnail candidates.
 * Accepts a discord.js User/GuildMember, or a plain descriptor object.
 *
 * @param {*} target
 * @returns {{display: string, avatar: string|null, id: string|null, tag: string|null}}
 */
function describeTarget(target) {
  if (!target) return { display: 'Unknown user', avatar: null, id: null, tag: null };

  if (typeof target === 'string') {
    const cleaned = cleanText(target, 100);
    return { display: cleaned || 'Unknown user', avatar: null, id: null, tag: null };
  }

  const id = target.id || (target.user && target.user.id) || null;
  const username = target.username || (target.user && target.user.username) || null;
  const globalName = target.globalName || (target.user && target.user.globalName) || null;
  const discriminator = target.discriminator || (target.user && target.user.discriminator) || null;
  const tag = username ? (discriminator && discriminator !== '0' ? `${username}#${discriminator}` : username) : null;
  const display = target.displayName || globalName || tag || (id ? `User ${id}` : 'Unknown user');
  const avatar = typeof target.displayAvatarURL === 'function'
    ? target.displayAvatarURL({ size: 128 })
    : (target.user && typeof target.user.displayAvatarURL === 'function'
      ? target.user.displayAvatarURL({ size: 128 })
      : null);

  return {
    display: clip(stripMentions(display), 80),
    avatar,
    id: id ? clip(String(id), 32) : null,
    tag: tag ? clip(stripMentions(tag), 80) : null,
  };
}

/**
 * Build the standard moderation embed.
 *
 * @param {object} options
 * @param {string} options.action        key from ACTIONS (e.g. "ban")
 * @param {*} [options.target]           user/member or display string
 * @param {*} [options.moderator]        user/member or display string
 * @param {string} [options.reason]
 * @param {string|number} [options.caseId]
 * @param {number} [options.durationMs]  for timed actions
 * @param {number} [options.expiresAtMs]
 * @param {Array} [options.extraFields]
 * @param {string} [options.description]
 * @param {string} [options.guildName]
 * @param {string} [options.footer]
 * @param {number} [options.color]       override the action color
 * @param {string} [options.title]       override the action title
 * @param {boolean} [options.timestamp]
 * @returns {object}
 */
function moderationEmbed(options = {}) {
  const actionKey = String(options.action || 'info').toLowerCase();
  const meta = ACTIONS[actionKey] || { title: 'Moderation Action', color: COLORS.info, severity: 'Info' };
  const target = describeTarget(options.target);
  const moderator = describeTarget(options.moderator);

  const fields = [];

  if (options.target) {
    const targetValue = target.tag && target.tag !== target.display
      ? `${target.display}\n${target.tag}${target.id ? ` (${target.id})` : ''}`
      : `${target.display}${target.id ? `\n${target.id}` : ''}`;
    fields.push({ name: 'Target', value: targetValue, inline: true });
  }

  if (options.moderator) {
    fields.push({ name: 'Moderator', value: `${moderator.display}${moderator.id ? `\n${moderator.id}` : ''}`, inline: true });
  }

  if (options.reason !== undefined) {
    fields.push({ name: 'Reason', value: stripMentions(cleanText(options.reason, 500)) || 'No reason provided', inline: false });
  }

  if (options.caseId !== undefined && options.caseId !== null) {
    fields.push({ name: 'Case ID', value: `#${String(options.caseId)}`, inline: true });
  }

  if (Number.isFinite(options.durationMs) && options.durationMs > 0) {
    let durationValue = formatDuration(options.durationMs);
    if (Number.isFinite(options.expiresAtMs)) {
      durationValue += `\nExpires ${formatAbsolute(options.expiresAtMs)}`;
    }
    fields.push({ name: 'Duration', value: durationValue, inline: true });
  }

  if (Number.isFinite(options.strikeCount)) {
    fields.push({ name: 'Active Strikes', value: String(options.strikeCount), inline: true });
  }

  if (Array.isArray(options.extraFields)) {
    for (const field of options.extraFields) fields.push(field);
  }

  fields.push({ name: 'Timestamp', value: formatAbsolute(options.timestampMs || Date.now()), inline: true });

  return baseEmbed({
    title: options.title || meta.title,
    description: options.description,
    color: options.color || meta.color,
    fields,
    footer: options.footer || (options.caseId ? `Case #${options.caseId}` : (options.guildName ? options.guildName : undefined)),
    thumbnail: options.thumbnail !== undefined ? options.thumbnail : target.avatar,
    image: options.image,
    timestamp: options.timestamp,
    timestampMs: options.timestampMs,
    author: options.author,
  });
}

/** Plain information embed (help, config, info commands). */
function infoEmbed(options = {}) {
  return baseEmbed({
    color: options.color || COLORS.info,
    footer: options.footer,
    author: options.author,
    ...options,
    color: options.color || COLORS.info,
  });
}

/** Success embed for confirmations and completed reversals. */
function successEmbed(options = {}) {
  return baseEmbed({
    ...options,
    title: options.title || 'Action Completed',
    color: options.color || COLORS.success,
  });
}

/**
 * Error embed for user-facing failures. Text is always generic unless a safe
 * UserError message was supplied by the caller.
 * @param {object} options
 */
function errorEmbed(options = {}) {
  return baseEmbed({
    title: options.title || 'Command Failed',
    description: cleanText(options.description || MESSAGES.genericError, EMBED_LIMITS.description),
    color: options.color || COLORS.error,
    footer: options.footer,
    fields: options.fields,
    timestamp: options.timestamp,
  });
}

/** Warning / notice embed (non-fatal problems, configuration hints). */
function noticeEmbed(options = {}) {
  return baseEmbed({
    title: options.title || 'Notice',
    color: options.color || COLORS.notice,
    ...options,
    color: options.color || COLORS.notice,
  });
}

/**
 * Log embed used by the logging system. Categories select the accent color so
 * message logs, member logs, and voice logs are distinguishable at a glance.
 *
 * @param {object} options
 * @param {string} options.category  mod | message | member | voice | server | automod
 * @param {string} options.title
 * @param {string} [options.description]
 * @param {Array} [options.fields]
 * @param {string} [options.guildName]
 * @param {string} [options.footer]
 * @param {string} [options.thumbnail]
 */
function logEmbed(options = {}) {
  const colorMap = {
    mod: COLORS.logMod,
    message: COLORS.logMessage,
    member: COLORS.logMember,
    voice: COLORS.logVoice,
    server: COLORS.logServer,
    automod: COLORS.logAutomod,
  };
  const color = options.color || colorMap[options.category] || COLORS.info;

  return baseEmbed({
    title: options.title || 'Log Event',
    description: options.description,
    color,
    fields: options.fields,
    footer: options.footer || options.guildName,
    thumbnail: options.thumbnail,
    image: options.image,
    timestamp: options.timestamp,
  });
}

/**
 * Paginated list embed: adds a "Page X of Y" footer.
 * @param {object} options base embed options
 * @param {number} page zero-based index
 * @param {number} totalPages
 */
function paginatedEmbed(options, page, totalPages) {
  const base = baseEmbed(options);
  const footerPrefix = options.footer ? `${options.footer} | ` : '';
  base.footer = { text: clip(`${footerPrefix}Page ${page + 1} of ${Math.max(1, totalPages)}`, EMBED_LIMITS.footer) };
  return base;
}

/**
 * Split long content into chunks small enough for embed descriptions,
 * preferring line boundaries.
 * @param {string} content
 * @param {number} maxLength
 * @returns {string[]}
 */
function chunkText(content, maxLength = 3800) {
  const text = String(content || '');
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let buffer = '';
  for (const line of text.split('\n')) {
    if (line.length > maxLength) {
      if (buffer) {
        chunks.push(buffer);
        buffer = '';
      }
      for (let index = 0; index < line.length; index += maxLength) {
        chunks.push(line.slice(index, index + maxLength));
      }
      continue;
    }
    if ((buffer + (buffer ? '\n' : '') + line).length > maxLength) {
      chunks.push(buffer);
      buffer = line;
    } else {
      buffer = buffer ? `${buffer}\n${line}` : line;
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

/**
 * Render a blank-line separated list of field candidates into fewer fields,
 * keeping each under the value limit. Useful for warnings lists and case lists.
 * @param {{name: string, value: string, inline?: boolean}[]} fieldList
 * @returns {Array}
 */
function compactFields(fieldList) {
  const output = [];
  let current = null;
  for (const field of fieldList) {
    const value = cleanText(field.value, EMBED_LIMITS.fieldValue);
    if (!current || (current.value.length + value.length + 2) > EMBED_LIMITS.fieldValue) {
      if (current) output.push(current);
      current = { name: clip(field.name, EMBED_LIMITS.fieldName), value, inline: false };
    } else {
      current.value += `\n${value}`;
    }
  }
  if (current) output.push(current);
  return output.slice(0, EMBED_LIMITS.fields);
}

/** Neutral "no results" embed for empty listings. */
function emptyEmbed(title, description, color = COLORS.neutral) {
  return baseEmbed({ title, description: description || 'Nothing to display.', color });
}

module.exports = {
  COLORS,
  baseEmbed,
  moderationEmbed,
  infoEmbed,
  successEmbed,
  errorEmbed,
  noticeEmbed,
  logEmbed,
  paginatedEmbed,
  chunkText,
  compactFields,
  emptyEmbed,
  describeTarget,
  clip,
};
