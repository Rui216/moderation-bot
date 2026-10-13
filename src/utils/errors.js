'use strict';

/**
 * Error taxonomy.
 *
 * Two classes of failures exist:
 *   1. UserError and its subclasses: safe, human readable messages that may be
 *      shown to the person who ran the command.
 *   2. Everything else: unexpected failures. The message shown to Discord is
 *      always the generic MESSAGES.genericError string; the real error is only
 *      written to the private log file and internal channel.
 */

const { MESSAGES } = require('../config/constants');

/** Error that is safe to display to users verbatim. */
class UserError extends Error {
  /**
   * @param {string} message Safe, plain-text message for Discord.
   * @param {{code?: string, details?: *}} options
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'UserError';
    this.safe = true;
    this.code = options.code || 'USER_ERROR';
    this.details = options.details;
  }
}

/** The invoker lacks the required permission level. */
class PermissionError extends UserError {
  constructor(message = MESSAGES.noPermission, options = {}) {
    super(message, { code: 'PERMISSION_DENIED', ...options });
    this.name = 'PermissionError';
  }
}

/** Role hierarchy or bot-permission prevents the action. */
class HierarchyError extends UserError {
  constructor(message = MESSAGES.hierarchy, options = {}) {
    super(message, { code: 'HIERARCHY_ERROR', ...options });
    this.name = 'HierarchyError';
  }
}

/** Invalid command usage or arguments. */
class ValidationError extends UserError {
  constructor(message, options = {}) {
    super(message, { code: 'VALIDATION_ERROR', ...options });
    this.name = 'ValidationError';
  }
}

/** The guild has not completed setup. */
class ConfigError extends UserError {
  constructor(message = MESSAGES.notConfigurable, options = {}) {
    super(message, { code: 'CONFIG_ERROR', ...options });
    this.name = 'ConfigError';
  }
}

/** Rate limit exceeded. */
class RateLimitError extends UserError {
  constructor(message, options = {}) {
    super(message, { code: 'RATE_LIMITED', ...options });
    this.name = 'RateLimitError';
    this.retryAfterMs = options.retryAfterMs || 0;
  }
}

/** Gateway / database failure. Never reveals transport details to users. */
class DatabaseError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'DatabaseError';
    this.safe = false;
    this.code = options.code || 'DATABASE_ERROR';
    this.details = options.details;
    this.status = options.status;
  }
}

/** Discord API failure wrapped with context for internal logs. */
class DiscordActionError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'DiscordActionError';
    this.safe = false;
    this.code = options.code || 'DISCORD_API_ERROR';
    this.userMessage = options.userMessage;
    this.details = options.details;
  }
}

/**
 * Decide what a user may see for a thrown error.
 * @param {Error} error
 * @returns {string} plain text, never containing internals
 */
function safeErrorMessage(error) {
  if (error && error.safe === true && typeof error.message === 'string' && error.message.length > 0) {
    return error.message;
  }
  return MESSAGES.genericError;
}

/** True when the error is one of our explicit, user-safe errors. */
function isUserError(error) {
  return Boolean(error && error.safe === true);
}

module.exports = {
  UserError,
  PermissionError,
  HierarchyError,
  ValidationError,
  ConfigError,
  RateLimitError,
  DatabaseError,
  DiscordActionError,
  safeErrorMessage,
  isUserError,
};
