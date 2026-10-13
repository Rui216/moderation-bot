'use strict';

/**
 * Structured logger with mandatory secret redaction.
 *
 * Rules enforced here:
 *   - Secret values registered through registerSecret() are replaced with
 *     "[redacted]" anywhere they appear in a logged string or object.
 *   - Objects are scrubbed recursively for keys that look sensitive
 *     (token, secret, authorization, password, key, webhook, cookie...).
 *   - Console output carries a short message plus, at debug level, a stack.
 *     Full stack traces additionally go to a private log file.
 *   - Nothing is thrown from the logger: logging must never break a command.
 */

const fs = require('fs');
const path = require('path');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

/** Values that must never appear in any log sink. */
const secretValues = new Set();

/** Keys whose values are always redacted when logging objects. */
const SENSITIVE_KEY_PATTERN = /(token|secret|password|passwd|authorization|auth|apikey|api_key|credential|cookie|webhook|bearer|signature|d1_database_id|database_id|account_id)/i;

/** Hard cap on logged string length so a stack trace cannot flood the console. */
const MAX_STRING_LENGTH = 4000;

let currentLevel = LEVELS.info;
let logToFile = true;
let logDir = 'logs';
let internalChannelHook = null;

function levelFromEnv(raw) {
  const value = String(raw || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, value) ? LEVELS[value] : LEVELS.info;
}

/**
 * Register a secret value so the logger can strip it from any output.
 * Called during environment validation for every secret in the environment.
 * @param {string} value
 */
function registerSecret(value) {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  // Ignore trivial values to avoid redacting common substrings.
  if (trimmed.length < 6) return;
  secretValues.add(trimmed);
}

/**
 * Redact registered secrets plus obvious token-shaped strings.
 * @param {string} input
 * @returns {string}
 */
function redactString(input) {
  let output = input;
  for (const secret of secretValues) {
    if (output.includes(secret)) {
      output = output.split(secret).join('[redacted]');
    }
  }
  // Discord bot tokens: three dot separated base64url chunks.
  output = output.replace(/\b[\w-]{20,}\.[\w-]{6,}\.[\w-]{25,}\b/g, '[redacted-token]');
  // Bearer headers and query strings.
  output = output.replace(/(Bearer\s+)[\w.\-]+/gi, '$1[redacted]');
  output = output.replace(/([?&](?:token|key|secret|code)=)[^&\s]+/gi, '$1[redacted]');
  // Cloudflare Worker URLs are infrastructure details: keep the shape, drop the host.
  output = output.replace(/https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.workers\.dev/gi, 'https://[worker-url]');
  return output;
}

/**
 * Redact a value of any shape. Errors become plain objects so no internal
 * reference or custom garbage is carried into the output.
 * @param {*} value
 * @param {number} depth
 * @returns {*}
 */
function redactValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '[depth-limit]';

  if (typeof value === 'string') {
    const clipped = value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]` : value;
    return redactString(clipped);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'function') return '[function]';
  if (value instanceof Error) {
    return {
      name: value.name,
      code: value.code,
      message: redactString(value.message || ''),
      stack: value.stack ? redactString(value.stack) : undefined,
      details: value.details ? redactValue(value.details, depth + 1) : undefined,
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        out[key] = '[redacted]';
      } else {
        out[key] = redactValue(item, depth + 1);
      }
    }
    return out;
  }
  return '[unloggable]';
}

function timestamp() {
  return new Date().toISOString();
}

function serialize(value) {
  if (value === undefined) return '';
  try {
    if (typeof value === 'string') return redactString(value);
    return JSON.stringify(redactValue(value));
  } catch {
    return '[unserializable]';
  }
}

function writeToFile(level, message, meta) {
  if (!logToFile) return;
  try {
    const dir = path.isAbsolute(logDir) ? logDir : path.join(process.cwd(), logDir);
    fs.mkdirSync(dir, { recursive: true });
    const line = `${timestamp()} [${level.toUpperCase()}] ${message}${meta ? ` ${serialize(meta)}` : ''}\n`;
    fs.appendFileSync(path.join(dir, 'internal.log'), line, 'utf8');
  } catch {
    // Never fail because the log sink is unavailable.
  }
}

function emit(level, message, meta) {
  if (LEVELS[level] > currentLevel) return;

  const safeMessage = redactString(String(message));
  const safeMeta = meta === undefined ? undefined : redactValue(meta);

  /* eslint-disable no-console */
  const stream = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (safeMeta === undefined) {
    stream(`${timestamp()} [${level.toUpperCase()}] ${safeMessage}`);
  } else {
    stream(`${timestamp()} [${level.toUpperCase()}] ${safeMessage} ${serialize(safeMeta)}`);
  }
  /* eslint-enable no-console */

  if (level === 'error') {
    writeToFile(level, safeMessage, safeMeta);
    if (internalChannelHook) {
      try {
        // The hook mirrors errors to a private channel; it must never throw.
        Promise.resolve(internalChannelHook(safeMessage, safeMeta)).catch(() => {});
      } catch {
        // ignored on purpose
      }
    }
  }
}

const logger = {
  /**
   * Configure the logger from environment values. Called once at startup.
   * @param {{level?: string, toFile?: boolean, dir?: string}} options
   */
  configure(options = {}) {
    if (options.level !== undefined) currentLevel = levelFromEnv(options.level);
    if (options.toFile !== undefined) logToFile = options.toFile !== false;
    if (options.dir) logDir = String(options.dir);
    return logger;
  },

  /**
   * Register a callback used to mirror error logs into a private Discord
   * channel. The callback receives already-redacted data.
   * @param {(message: string, meta: *) => Promise<void>|void} hook
   */
  setInternalChannelHook(hook) {
    internalChannelHook = typeof hook === 'function' ? hook : null;
  },

  registerSecret,
  redact: redactString,
  redactValue,

  error(message, meta) {
    emit('error', message, meta);
  },
  warn(message, meta) {
    emit('warn', message, meta);
  },
  info(message, meta) {
    emit('info', message, meta);
  },
  debug(message, meta) {
    emit('debug', message, meta);
  },

  /** Create a namespaced logger, e.g. logger.child('automod').debug(...). */
  child(namespace) {
    const prefix = `[${namespace}]`;
    return {
      error: (message, meta) => emit('error', `${prefix} ${message}`, meta),
      warn: (message, meta) => emit('warn', `${prefix} ${message}`, meta),
      info: (message, meta) => emit('info', `${prefix} ${message}`, meta),
      debug: (message, meta) => emit('debug', `${prefix} ${message}`, meta),
    };
  },

  level: () => LEVELS,
};

module.exports = { logger, redactString, redactValue, registerSecret };
