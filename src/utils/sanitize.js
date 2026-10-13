'use strict';

/**
 * Input sanitization and validation helpers.
 *
 * Any value that originates from a Discord message, a modal, or a select menu
 * passes through one of these functions before it is stored, embedded, or sent
 * to the gateway. The gateway performs the same validation server side, so a
 * compromised client cannot smuggle anything into a SQL statement: every query
 * uses bound parameters and identifiers are checked against strict patterns.
 */

const { EMBED_LIMITS } = require('../config/constants');

const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
// Control characters except tab and newline, plus zero-width and bidi marks
// that are commonly used to spoof or confuse log output.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/** True when the value looks like a Discord snowflake. */
function isSnowflake(value) {
  return typeof value === 'string' && SNOWFLAKE_PATTERN.test(value);
}

/**
 * Throw-free snowflake check that also accepts numbers.
 * @param {*} value
 * @returns {string|null} normalized string id or null
 */
function toSnowflake(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  return isSnowflake(value) ? value : null;
}

/**
 * Remove control characters and trim to a maximum length.
 * @param {*} value
 * @param {number} maxLength
 * @returns {string}
 */
function cleanText(value, maxLength = EMBED_LIMITS.fieldValue) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  text = text.replace(CONTROL_CHARS, '');
  text = text.replace(/\r\n/g, '\n').trim();
  if (text.length > maxLength) text = `${text.slice(0, Math.max(0, maxLength - 3))}...`;
  return text;
}

/**
 * Neutralize @everyone, @here, and role/user mention syntax so a stored reason
 * cannot be replayed later as a mention ping.
 * @param {string} text
 * @returns {string}
 */
function stripMentions(text) {
  if (!text) return '';
  return String(text)
    .replace(/@everyone/gi, '@ everyone')
    .replace(/@here/gi, '@ here')
    .replace(/<@[!&]?(\d{17,20})>/g, '@user')
    .replace(/<a?:(\w+):\d+>/g, ':$1:');
}

/**
 * Escape Discord markdown so untrusted content cannot alter embed formatting.
 * @param {string} text
 * @returns {string}
 */
function escapeMarkdown(text) {
  if (!text) return '';
  return String(text).replace(/([\\`*_~|>])/g, '\\$1');
}

/**
 * Prepare a reason string for storage and display.
 * @param {*} value
 * @param {{maxLength?: number, fallback?: string, escape?: boolean}} options
 * @returns {string}
 */
function sanitizeReason(value, options = {}) {
  const { maxLength = 500, fallback = 'No reason provided', escape = false } = options;
  let text = cleanText(value, maxLength);
  text = stripMentions(text);
  text = text.replace(/\n{3,}/g, '\n\n');
  if (!text) return fallback;
  return escape ? escapeMarkdown(text) : text;
}

/**
 * Validate a URL supplied as evidence. Only http(s) links are stored, and the
 * query string is preserved because screenshot hosts often use signed URLs.
 * @param {*} value
 * @returns {string|null}
 */
function sanitizeUrl(value) {
  const text = cleanText(value, 800);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Validate a domain or hostname used in automod allow/block lists.
 * Rejects protocols, paths, spaces, and wildcards so matching stays simple.
 * @param {*} value
 * @returns {string|null} normalized lowercase hostname
 */
function sanitizeDomain(value) {
  let text = cleanText(value, 253).toLowerCase();
  text = text.replace(/^https?:\/\//, '').replace(/^www\./, '');
  text = text.split('/')[0].split('?')[0].split('#')[0].trim();
  if (!text) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(text)) return null;
  return text;
}

/**
 * Sanitize a banned word entry. Multi-word phrases are allowed but the value
 * is normalized to lowercase and stripped of regex metacharacters so it can
 * never be interpreted as a pattern when matched with includes().
 * @param {*} value
 * @returns {string|null}
 */
function sanitizeWord(value) {
  const text = cleanText(value, 64).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '');
  return text.length >= 2 ? text : null;
}

/**
 * Validate a per-guild command prefix: 1 to 5 characters, no whitespace,
 * no characters that would be ambiguous in Discord messages.
 * @param {*} value
 * @returns {string|null}
 */
function sanitizePrefix(value) {
  const text = cleanText(value, 5).replace(/\s+/g, '');
  if (!text) return null;
  if (/[`@#:\\/]/.test(text)) return null;
  return text.slice(0, 5);
}

/**
 * De-duplicate and normalize a list of snowflakes, capped to a sane size.
 * @param {*} values
 * @param {number} max
 * @returns {string[]}
 */
function sanitizeIdList(values, max = 100) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const id = toSnowflake(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    output.push(id);
    if (output.length >= max) break;
  }
  return output;
}

/**
 * Clamp an integer to a range, returning the fallback when not numeric.
 * @param {*} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampInt(value, min, max, fallback = min) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

module.exports = {
  isSnowflake,
  toSnowflake,
  cleanText,
  stripMentions,
  escapeMarkdown,
  sanitizeReason,
  sanitizeUrl,
  sanitizeDomain,
  sanitizeWord,
  sanitizePrefix,
  sanitizeIdList,
  clampInt,
  CONTROL_CHARS,
};
