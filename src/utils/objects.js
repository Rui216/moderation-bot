'use strict';

/**
 * Small object helpers used when merging stored configuration with defaults.
 * A missing key in the database must never break a handler, so every read of a
 * configuration document goes through deepMerge(config, defaults).
 */

/** True for plain objects only (not arrays, dates, or class instances). */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Recursively merge source into target. Values from `source` win.
 * Arrays and primitives are replaced, never concatenated.
 * @param {*} target
 * @param {*} source
 * @param {number} depth guard against pathological input
 * @returns {*}
 */
function deepMerge(target, source, depth = 0) {
  if (depth > 8) return source === undefined ? target : source;
  if (source === undefined) return target;
  if (source === null) return null;
  if (Array.isArray(source)) return source.slice();
  if (!isPlainObject(source)) return source;
  if (!isPlainObject(target)) return deepMerge({}, source, depth + 1);

  const output = { ...target };
  for (const [key, value] of Object.entries(source)) {
    output[key] = deepMerge(target[key], value, depth + 1);
  }
  return output;
}

/** Deep clone for plain JSON structures. */
function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Pick only the keys that differ between next and current.
 * Used to send minimal patches to the gateway.
 * @param {object} next
 * @param {object} current
 * @returns {object}
 */
function diffPatch(next, current) {
  const patch = {};
  for (const [key, value] of Object.entries(next || {})) {
    if (isPlainObject(value)) {
      const nested = diffPatch(value, (current && current[key]) || {});
      if (Object.keys(nested).length > 0) patch[key] = nested;
    } else if (JSON.stringify(value) !== JSON.stringify(current ? current[key] : undefined)) {
      patch[key] = value;
    }
  }
  return patch;
}

/**
 * Assert that a value is one of an allowed set, returning a fallback otherwise.
 * @param {*} value
 * @param {string[]} allowed
 * @param {*} fallback
 */
function coerceEnum(value, allowed, fallback) {
  const text = String(value || '').toLowerCase();
  return allowed.includes(text) ? text : fallback;
}

/** Safely read a nested property by path, e.g. get(obj, 'a.b.c', default). */
function getPath(object, path, fallback = undefined) {
  const segments = String(path).split('.');
  let current = object;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== 'object') return fallback;
    current = current[segment];
  }
  return current === undefined ? fallback : current;
}

module.exports = { isPlainObject, deepMerge, deepClone, diffPatch, coerceEnum, getPath };
