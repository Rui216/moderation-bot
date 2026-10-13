/**
 * Input validation for the gateway.
 *
 * This module is intentionally self-contained: the edge boundary must not
 * depend on code shipped with the bot. The rules mirror src/utils/sanitize.js
 * on the bot side, so a request that the bot would reject is also rejected
 * here, and a request crafted by hand is rejected too.
 *
 * Every value is either converted to a safe primitive or rejected; nothing is
 * ever interpolated into SQL text. Callers must still use bound parameters.
 */

const SNOWFLAKE = /^\d{17,20}$/;
const MAX_STRING = 4000;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/** Error thrown for invalid input; mapped to HTTP 422 by the router. */
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Require a Discord snowflake in path or body data. */
export function requireSnowflake(value, field = 'id') {
  const text = String(value ?? '').trim();
  if (!SNOWFLAKE.test(text)) throw new ValidationError(`${field} must be a Discord snowflake`);
  return text;
}

/** Optional snowflake: returns null instead of throwing when absent. */
export function optionalSnowflake(value, field = 'id') {
  if (value === null || value === undefined || value === '') return null;
  return requireSnowflake(value, field);
}

/** Sanitize free text: strip control characters, trim, cap length. */
export function text(value, maxLength = MAX_STRING) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(CONTROL_CHARS, '').trim();
  if (!cleaned) return null;
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

/** Require non-empty text with a maximum length. */
export function requireText(value, field, maxLength = MAX_STRING) {
  const cleaned = text(value, maxLength);
  if (!cleaned) throw new ValidationError(`${field} is required`);
  return cleaned;
}

/** Clamp an integer into a range, with a fallback for non-numeric input. */
export function int(value, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = null, field = 'value' } = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    if (fallback !== null) return fallback;
    throw new ValidationError(`${field} must be an integer`);
  }
  return Math.min(Math.max(parsed, min), max);
}

/** Boolean coercion accepting real booleans and the usual string forms. */
export function bool(value, fallback = false) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

/** Restrict a value to an allowlist of known enum members. */
export function oneOf(value, allowed, field = 'value') {
  const text_ = String(value ?? '').trim();
  if (!allowed.includes(text_)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return text_;
}

/** Array of snowflakes, de-duplicated and capped. */
export function snowflakeArray(value, field = 'list', max = 200) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be an array`);
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const id = optionalSnowflake(entry, field);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

/** De-duplicated, lowercased list of plain strings. */
export function stringArray(value, { field = 'list', max = 500, maxLength = 200 } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be an array`);
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const cleaned = text(entry, maxLength);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= max) break;
  }
  return out;
}

/** Require a JSON object (not an array, not null). */
export function requireObject(value, field = 'object') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${field} must be an object`);
  }
  return value;
}

/** Optional JSON object; falls back to an empty object. */
export function optionalObject(value, field = 'object') {
  if (value === undefined || value === null) return {};
  return requireObject(value, field);
}

/**
 * Bound the size of an arbitrary JSON value so a client cannot store an
 * unbounded document in D1. Returns a compacted clone.
 */
export function boundJson(value, maxBytes = 32768) {
  const serialized = JSON.stringify(value ?? {});
  if (serialized === undefined) return {};
  if (serialized.length <= maxBytes) return value ?? {};
  // Too large: keep the operation safe by storing a truncated marker instead
  // of silently dropping the write.
  return { truncated: true, reason: 'payload exceeds size limit' };
}

/** Parse a JSON column that may be NULL or malformed. */
export function parseJsonColumn(value, fallback = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** Serialize a value for storage in a JSON column. */
export function toJsonColumn(value, fallback = {}) {
  try {
    const serialized = JSON.stringify(value === undefined ? fallback : value);
    return serialized === undefined ? JSON.stringify(fallback) : serialized;
  } catch {
    return JSON.stringify(fallback);
  }
}

/** Unix epoch milliseconds, for consistent timestamps. */
export function nowMs() {
  return Date.now();
}

/** Validate a URL used for evidence attachments (http/https only). */
export function optionalUrl(value, field = 'url') {
  const cleaned = text(value, 800);
  if (!cleaned) return null;
  try {
    const parsed = new URL(cleaned);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('protocol');
    if (parsed.username || parsed.password) throw new Error('credentials');
    return parsed.toString();
  } catch {
    throw new ValidationError(`${field} must be a valid http or https URL`);
  }
}
