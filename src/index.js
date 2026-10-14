'use strict';

/**
 * Application entry point.
 *
 * Startup order:
 *   1. Load and validate the environment (secrets are registered for redaction).
 *   2. Initialise the data layer (Cloudflare Worker gateway).
 *   3. Build the shared services bag.
 *   4. Load commands and register event listeners.
 *   5. Start the health endpoint, the scheduled task worker, and the heartbeat.
 *   6. Log in to Discord.
 *
 * Shutdown is graceful: listeners are removed, the scheduler stops claiming
 * work, pending log embeds are flushed, and the process exits with a code the
 * Wispbyte process manager can act on.
 */

const path = require('path');

const { loadConfig } = require('./config/env');
const { logger } = require('./utils/logger');
const { initDatabase, getGateway, repo } = require('./db');

const { createClient, applyPresence, attachLifecycle } = require('./core/client');
const registry = require('./core/registry');
const events = require('./events');
const healthService = require('./services/healthService');
const taskService = require('./services/taskService');
const rateLimitService = require('./services/rateLimitService');
const loggingService = require('./services/loggingService');

const permissionService = require('./services/permissionService');
const hierarchyService = require('./services/hierarchyService');
const punishmentService = require('./services/punishmentService');
const channelService = require('./services/channelService');
const moderationService = require('./services/moderationService');
const dmService = require('./services/dmService');
const automodService = require('./automod/automodService');
const raidService = require('./automod/raidService');

const log = logger.child('startup');

/** Version string reported to the gateway heartbeat. */
const VERSION = require('../package.json').version;

/** Set once login succeeds so the shutdown path can reference it. */
let client = null;
let heartbeatTimer = null;
let shuttingDown = false;

/**
 * Build the services bag shared by commands, events, and scheduled tasks.
 * @param {object} appConfig
 */
function buildServices(appConfig) {
  return {
    appConfig,
    permissionService,
    hierarchyService,
    punishmentService,
    channelService,
    moderationService,
    loggingService,
    dmService,
    automodService,
    raidService,
    taskService,
    healthService,
    rateLimitService,
  };
}

/** Send a heartbeat and report simple diagnostics to the gateway. */
async function sendHeartbeat() {
  if (!client || !client.isReady()) return;

  const latency = Number.isFinite(client.ws.ping) ? Math.max(0, Math.round(client.ws.ping)) : null;
  healthService.update({ guildCount: client.guilds.cache.size, latencyMs: latency });

  await getGateway().heartbeat({
    version: VERSION,
    startedAt: healthService.state.startedAt,
    guildCount: client.guilds.cache.size,
    latencyMs: latency,
    notes: `node ${process.version}`,
  });
}

/**
 * Start the bot.
 */
async function main() {
  const appConfig = loadConfig();

  initDatabase(appConfig);
  rateLimitService.configure(appConfig);
  loggingService.configure(appConfig);

  const services = buildServices(appConfig);
  client = createClient(appConfig, services);
  attachLifecycle(client);

  const commandCount = registry.loadDirectory(path.join(__dirname, 'commands'));
  if (commandCount === 0) {
    log.error('No commands were loaded. Check src/commands for syntax errors.');
  }

  events.registerAll(client, { appConfig, limits: appConfig.limits });

  healthService.start(appConfig.health);

  // Verify storage connectivity early so a misconfigured gateway is obvious
  // in the startup log instead of surfacing on the first command.
  try {
    const readiness = await getGateway().health();
    log.info('Storage gateway reachable', { database: readiness.database, cache: readiness.cache });
  } catch (error) {
    log.warn('Storage gateway is not reachable at startup. Commands will fail until it recovers.', {
      code: error && error.code,
    });
  }

  try {
    await client.login(appConfig.discord.token);
  } catch (error) {
    // Never print the token; the error message from discord.js is safe.
    log.error('Discord login failed', { message: error && error.message, code: error && error.code });
    process.exit(1);
  }

  await applyPresence(client, appConfig);
  healthService.update({ ready: true, guildCount: client.guilds.cache.size, version: VERSION });

  taskService.start(appConfig, { client, limits: appConfig.limits });

  await sendHeartbeat();
  heartbeatTimer = setInterval(() => {
    void sendHeartbeat();
  }, 5 * 60 * 1000);
  if (heartbeatTimer.unref) heartbeatTimer.unref();

  if (appConfig.discord.enableSlashCommands) {
    try {
      const { registerAll } = require('./core/slashRegistrar');
      await registerAll(client, appConfig);
    } catch (error) {
      // Logged without the token or the raw response body.
      log.warn('Slash command registration failed', { code: error && error.code, message: error && error.message });
    }
  }

  log.info('Bot ready', {
    user: client.user ? client.user.tag : 'unknown',
    guilds: client.guilds.cache.size,
    commands: commandCount,
    prefix: appConfig.discord.defaultPrefix,
  });
}

/**
 * Graceful shutdown.
 * @param {string} signal
 */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info('Shutdown requested', { signal });
  healthService.update({ shutdown: true, ready: false });

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  taskService.stop();

  // Deliver anything still queued so the last log entries are not lost.
  const pendingLogs = await loggingService.flush(3000).catch(() => 0);
  if (pendingLogs > 0) log.warn('Some log entries could not be delivered before shutdown', { pending: pendingLogs });

  await healthService.stop().catch(() => null);

  if (client) {
    client.removeAllListeners();
    await client.destroy().catch(() => null);
  }

  log.info('Shutdown complete');

  // Allow the logger to flush its file handle before exiting.
  setTimeout(() => process.exit(0), 250);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

// Exported for tests. Running the file directly starts the bot.
if (require.main === module) {
  main().catch((error) => {
    log.error('Fatal startup failure', { message: error && error.message, stack: error && error.stack });
    process.exit(1);
  });
}

module.exports = { main, shutdown, buildServices, repo };
