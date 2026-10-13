'use strict';

/**
 * Duration parsing and formatting.
 *
 * Supported input: "1d", "2h30m", "90m", "1w3d12h", "45" (seconds), "1 hour".
 * Supported output: compact human strings such as "1d 2h 30m" and Discord
 * relative timestamps for embeds.
 */

const { DURATION_UNITS } = require('../config/constants');

const UNIT_PATTERN = /(\d+(?:\.\d+)?)\s*([a-z]+)/gi;

/**
 * Parse a duration expression into milliseconds.
 * @param {*} input
 * @param {{maxMs?: number, minMs?: number}} options
 * @returns {{ok: true, ms: number, text: string}|{ok: false, reason: string}}
 */
function parseDuration(input, options = {}) {
  const { maxMs = Number.MAX_SAFE_INTEGER, minMs = 1000 } = options;

  if (input === null || input === undefined) return { ok: false, reason: 'empty' };

  // Numbers are interpreted as seconds, mirroring how moderators type them.
  if (typeof input === 'number' && Number.isFinite(input)) {
    const ms = Math.round(input * 1000);
    return validateMs(ms, input, minMs, maxMs);
  }

  const text = String(input).trim().toLowerCase();
  if (!text) return { ok: false, reason: 'empty' };

  if (/^\d+$/.test(text)) {
    const ms = Number.parseInt(text, 10) * 1000;
    return validateMs(ms, text, minMs, maxMs);
  }

  let total = 0;
  let matched = false;
  let lastIndex = 0;

  UNIT_PATTERN.lastIndex = 0;
  let match = UNIT_PATTERN.exec(text);
  while (match !== null) {
    // Reject gaps such as "1d foo 2h" so typos are surfaced, not ignored.
    const gap = text.slice(lastIndex, match.index).trim();
    if (gap && !/^[\s,]+$/.test(gap)) return { ok: false, reason: 'unparsable' };

    const amount = Number.parseFloat(match[1]);
    const unit = match[2];
    const multiplier = DURATION_UNITS[unit];
    if (multiplier === undefined) return { ok: false, reason: 'unknown-unit' };

    total += amount * multiplier;
    matched = true;
    lastIndex = match.index + match[0].length;
    match = UNIT_PATTERN.exec(text);
  }

  const remainder = text.slice(lastIndex).trim();
  if (remainder && !/^[\s,]+$/.test(remainder)) return { ok: false, reason: 'unparsable' };
  if (!matched) return { ok: false, reason: 'unparsable' };

  return validateMs(Math.round(total), text, minMs, maxMs);
}

function validateMs(ms, text, minMs, maxMs) {
  if (!Number.isFinite(ms) || ms <= 0) return { ok: false, reason: 'non-positive' };
  if (ms < minMs) return { ok: false, reason: 'too-short' };
  if (ms > maxMs) return { ok: false, reason: 'too-long' };
  return { ok: true, ms, text: String(text) };
}

/**
 * Format milliseconds into a compact, human readable string.
 * @param {number} ms
 * @returns {string} e.g. "3d 4h 12m"
 */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';

  const units = [
    { label: 'w', size: 7 * 24 * 60 * 60 * 1000 },
    { label: 'd', size: 24 * 60 * 60 * 1000 },
    { label: 'h', size: 60 * 60 * 1000 },
    { label: 'm', size: 60 * 1000 },
    { label: 's', size: 1000 },
  ];

  const parts = [];
  let remaining = Math.floor(ms);
  for (const unit of units) {
    if (remaining >= unit.size) {
      const value = Math.floor(remaining / unit.size);
      remaining -= value * unit.size;
      parts.push(`${value}${unit.label}`);
    }
    if (parts.length === 3) break;
  }
  return parts.length > 0 ? parts.join(' ') : '0s';
}

/**
 * Format milliseconds as a Discord relative timestamp: <t:unix:R>.
 * @param {number} ms epoch milliseconds
 * @returns {string}
 */
function formatTimestamp(ms) {
  if (!Number.isFinite(ms)) return 'Unknown';
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

/** Format an absolute Discord timestamp: <t:unix:F>. */
function formatAbsolute(ms) {
  if (!Number.isFinite(ms)) return 'Unknown';
  return `<t:${Math.floor(ms / 1000)}:F>`;
}

/** Humanize a millisecond age, e.g. "3 days ago" without emoji. */
function humanizeAge(ms) {
  const seconds = Math.floor(Math.max(0, Date.now() - ms) / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'} ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

/** Seconds remaining until a future timestamp, floored at zero. */
function secondsUntil(ms) {
  return Math.max(0, Math.ceil((ms - Date.now()) / 1000));
}

module.exports = {
  parseDuration,
  formatDuration,
  formatTimestamp,
  formatAbsolute,
  humanizeAge,
  secondsUntil,
};
