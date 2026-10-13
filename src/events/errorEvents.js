'use strict';

/**
 * Process-level error safety nets.
 *
 * Unexpected errors are logged with redaction and mirrored to the private
 * internal channel configured through LOG_INTERNAL_CHANNEL_ID. The process is
 * only terminated for genuinely unrecoverable conditions, so a single failed
 * API call never takes the bot offline on Wispbyte.
 */

const { logger } = require('../utils/logger');
const loggingService = require('../services/loggingService');
const healthService = require('../services/healthService');

const log = logger.child('process');

/**
 * Install handlers.
 * @param {import('discord.js').Client} client
 * @param {object} appConfig
 * @param {{ onFatal?: Function }} [options]
 */
function register(client, appConfig, options = {}) {
  // Mirror error logs into the private internal channel.
  logger.setInternalChannelHook((message, meta) => loggingService.sendInternalError(client, message, meta));

  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error('Unhandled rejection with a non-error value');
    log.error('Unhandled promise rejection', {
      message: error.message,
      stack: error.stack,
      code: error.code,
    });
    healthService.update({ degraded: true });
  });

  process.on('uncaughtException', (error) => {
    log.error('Uncaught exception', { message: error.message, stack: error.stack, code: error.code });
    healthService.update({ degraded: true });

    // The process may be in an unknown state: report and exit so the process
    // manager on Wispbyte restarts a clean instance.
    log.error('Shutting down after an uncaught exception so the process manager can restart cleanly.');
    if (typeof options.onFatal === 'function') options.onFatal(error);
    process.exit(1);
  });

  process.on('warning', (warning) => {
    log.debug('Node process warning', { name: warning.name, message: warning.message });
  });

  if (appConfig && appConfig.nodeEnv === 'development') {
    // Surface deprecation notices during local development only.
    process.on('deprecation', (warning) => log.warn('Deprecation notice', { message: warning.message }));
  }
}

module.exports = { register };
