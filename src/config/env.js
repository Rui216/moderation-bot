'use strict';

/**
 * Environment loading and validation.
 *
 * The bot reads every piece of configuration from environment variables only:
 * there is no hardcoded token, guild ID, channel ID, or Worker URL anywhere in
 * the source. Values are validated once at startup, secrets are registered for
 * redaction with the logger, and nothing here is ever printed verbatim.
 */

const path = require('path');

// Load .env from the project root when present. In production (Wispbyte) the
// panel supplies real environment variables and .env may not exist at all.
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const { logger, registerSecret } = require('../utils/logger');

/** Variables that must be present for the bot to function. */
const REQUIRED_VARS = ['DISCORD_TOKEN', 'WORKER_BASE_URL', 'WORKER_AUTH_TOKEN'];

function raw(name) {
  const value = process.env[name];
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function optionalString(name, fallback = '') {
  const value = raw(name);
  return value === '' ? fallback : value;
}

function bool(name, fallback) {
  const value = raw(name).toLowerCase();
  if (value === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(value);
}

function int(name, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = raw(name);
  if (value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/**
 * Parse a comma separated list of Discord snowflakes.
 * Invalid entries are dropped rather than crashing the process.
 */
function idList(name) {
  return raw(name)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => /^\d{5,25}$/.test(entry));
}

/**
 * Parse a duration environment value such as "28d" into milliseconds.
 * Falls back to the provided default when unparsable.
 */
function durationEnv(name, fallbackMs) {
  // Imported lazily to keep the module dependency-light at load time.
  const { parseDuration } = require('../utils/duration');
  const value = raw(name);
  if (!value) return fallbackMs;
  const parsed = parseDuration(value);
  return parsed.ok ? parsed.ms : fallbackMs;
}

function buildConfig() {
  const nodeEnv = optionalString('NODE_ENV', 'development');
  const isProduction = nodeEnv === 'production';

  const workerBaseUrl = optionalString('WORKER_BASE_URL').replace(/\/+$/, '');
  const discordToken = raw('DISCORD_TOKEN');
  const workerAuthToken = raw('WORKER_AUTH_TOKEN');

  const config = {
    nodeEnv,
    isProduction,

    discord: {
      token: discordToken,
      defaultPrefix: optionalString('DEFAULT_PREFIX', '!').slice(0, 5) || '!',
      enableSlashCommands: bool('ENABLE_SLASH_COMMANDS', false),
      slashDevGuildId: optionalString('SLASH_DEV_GUILD_ID') || null,
      ownerIds: idList('BOT_OWNER_IDS'),
      activity: {
        text: optionalString('BOT_ACTIVITY', 'Server moderation'),
        type: optionalString('BOT_ACTIVITY_TYPE', 'WATCHING').toUpperCase(),
      },
      // Intents the bot requests. GuildMembers and MessageContent are
      // privileged and must be enabled in the Developer Portal.
      intents: ['Guilds', 'GuildMembers', 'GuildModeration', 'GuildMessages', 'GuildVoiceStates', 'MessageContent', 'DirectMessages'],
    },

    worker: {
      baseUrl: workerBaseUrl,
      authToken: workerAuthToken,
      timeoutMs: int('WORKER_TIMEOUT_MS', 10000, { min: 1000, max: 60000 }),
      maxRetries: int('WORKER_MAX_RETRIES', 3, { min: 0, max: 6 }),
    },

    logging: {
      level: optionalString('LOG_LEVEL', isProduction ? 'info' : 'debug'),
      internalChannelId: optionalString('LOG_INTERNAL_CHANNEL_ID') || null,
      toFile: bool('LOG_TO_FILE', true),
      dir: optionalString('LOG_DIR', 'logs'),
    },

    health: {
      enabled: bool('HEALTH_ENABLED', true),
      host: optionalString('HEALTH_HOST', '0.0.0.0'),
      // PORT=0 disables the health listener entirely (useful on hosts that
      // do not allow inbound ports), so the lower bound is zero on purpose.
      port: int('PORT', 3000, { min: 0, max: 65535 }),
    },

    rateLimit: {
      enabled: bool('RATE_LIMIT_ENABLED', true),
      windowMs: int('RATE_LIMIT_WINDOW_MS', 10000, { min: 1000, max: 600000 }),
      maxCommands: int('RATE_LIMIT_MAX_COMMANDS', 6, { min: 1, max: 100 }),
      maxModActions: int('RATE_LIMIT_MAX_MOD_ACTIONS', 3, { min: 1, max: 100 }),
    },

    scheduler: {
      enabled: bool('SCHEDULER_ENABLED', true),
      intervalMs: int('SCHEDULER_INTERVAL_MS', 30000, { min: 5000, max: 600000 }),
      batchSize: int('SCHEDULER_BATCH_SIZE', 25, { min: 1, max: 100 }),
      startupGraceMs: int('SCHEDULER_STARTUP_GRACE_MS', 5000, { min: 0, max: 300000 }),
    },

    limits: {
      maxPurgeCount: int('MAX_PURGE_COUNT', 1000, { min: 1, max: 1000 }),
      maxTimeoutMs: durationEnv('MAX_TIMEOUT_DURATION', 28 * 24 * 60 * 60 * 1000),
      maxTempbanMs: durationEnv('MAX_TEMPBAN_DURATION', 365 * 24 * 60 * 60 * 1000),
    },
  };

  return config;
}

/**
 * Validate a loaded configuration object.
 * @param {object} config
 * @returns {{errors: string[], warnings: string[]}}
 */
function validateConfig(config) {
  const errors = [];
  const warnings = [];

  for (const name of REQUIRED_VARS) {
    if (!raw(name)) errors.push(`Missing required environment variable: ${name}`);
  }

  if (config.discord.token && !/^[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,}$/.test(config.discord.token)) {
    warnings.push('DISCORD_TOKEN does not look like a standard bot token. Double check the value.');
  }

  if (config.worker.baseUrl) {
    let parsed = null;
    try {
      parsed = new URL(config.worker.baseUrl);
    } catch {
      errors.push('WORKER_BASE_URL is not a valid URL.');
    }
    if (parsed) {
      if (!['https:', 'http:'].includes(parsed.protocol)) {
        errors.push('WORKER_BASE_URL must use http or https.');
      }
      if (config.isProduction && parsed.protocol !== 'https:') {
        errors.push('WORKER_BASE_URL must use https in production.');
      }
      if (parsed.username || parsed.password) {
        errors.push('WORKER_BASE_URL must not embed credentials.');
      }
      if (parsed.search || parsed.hash) {
        errors.push('WORKER_BASE_URL must not contain query strings or fragments.');
      }
    }
  }

  if (config.worker.authToken && config.worker.authToken.length < 24) {
    warnings.push('WORKER_AUTH_TOKEN is shorter than 24 characters. Use a long random value.');
  }

  if (!['PLAYING', 'WATCHING', 'LISTENING', 'COMPETING', 'CUSTOM'].includes(config.discord.activity.type)) {
    warnings.push('BOT_ACTIVITY_TYPE is not a recognized activity type. Falling back to WATCHING.');
    config.discord.activity.type = 'WATCHING';
  }

  if (config.health.port === 0) warnings.push('Health endpoint disabled because PORT is 0.');

  return { errors, warnings };
}

let cached = null;

/**
 * Return the validated configuration singleton.
 * @param {{exitOnError?: boolean}} options
 */
function loadConfig(options = {}) {
  if (cached) return cached;

  const config = buildConfig();
  const { errors, warnings } = validateConfig(config);

  // Register every secret so it can never reach a log sink verbatim.
  registerSecret(config.discord.token);
  registerSecret(config.worker.authToken);

  logger.configure({
    level: config.logging.level,
    toFile: config.logging.toFile,
    dir: config.logging.dir,
  });

  for (const warning of warnings) logger.warn(warning);

  if (errors.length > 0) {
    for (const error of errors) logger.error(error);
    if (options.exitOnError !== false) {
      logger.error('Startup aborted: fix the environment variables listed above and restart.');
      process.exit(1);
    }
  }

  cached = config;
  return cached;
}

/** Test helper: drop the cached configuration. */
function resetConfigCache() {
  cached = null;
}

module.exports = { loadConfig, resetConfigCache, REQUIRED_VARS };
