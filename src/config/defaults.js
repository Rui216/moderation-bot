'use strict';

/**
 * Default configuration documents.
 *
 * These objects are the single source of truth for what a freshly configured
 * guild looks like. The setup wizard starts from these values, the gateway
 * merges partial updates on top of them, and the bot deep-merges whatever it
 * reads back out of the database so a missing key never crashes a handler.
 */

const { LOG_EVENTS } = require('./constants');

/** Build the default per-event logging preference map. */
function buildDefaultLogEvents() {
  const events = {};
  for (const [key, meta] of Object.entries(LOG_EVENTS)) {
    events[key] = {
      enabled: meta.defaultEnabled,
      // null means "use the channel assigned to the event's default slot".
      channelId: null,
    };
  }
  return events;
}

/** Default guild configuration document. */
function defaultGuildConfig() {
  return {
    prefix: null, // null -> fall back to DEFAULT_PREFIX from the environment
    prefixEnabled: true,
    slashEnabled: false,

    // Authorization
    modRoleIds: [],
    adminRoleIds: [],
    trustedRoleIds: [],

    // Muting uses Discord's native timeout; a role is optional and only used
    // for the legacy "mute role" pattern where channels must deny send perms.
    mutedRoleId: null,
    muteRoleEnabled: false,

    // Behaviour
    requireReason: true,
    dmOnPunishment: true,
    deleteCommandMessages: false,

    // Logging lives in the dedicated logging_settings document
    // (defaultLoggingConfig below), which is the single source of truth for
    // channel routing and per-event toggles.

    // Lockdown defaults
    lockdown: {
      channelIds: [],
      roleIds: [],
      autoUnlockMinutes: 0,
    },

    // Extensible per-guild flags: nickname locks and other small state.
    misc: {
      nickLocks: {},        // userId -> enforced nickname
      nickLockAll: false,   // when true every nickname change is reverted
      nickLockRoleIds: [],
    },

    // Misc
    locale: 'en',
    configuredAt: null,
    configuredBy: null,
  };
}

/** Default automod configuration document. */
function defaultAutomodConfig() {
  return {
    enabled: true,
    exemptions: {
      roleIds: [],
      channelIds: [],
      // Bots are always ignored in automod evaluation, this flag is explicit
      // for documentation purposes.
      ignoreBots: true,
      // Members holding a moderator role or higher are exempt from automod by
      // default so staff are never punished by their own filters.
      ignoreStaff: true,
    },
    rules: {
      invites: {
        enabled: true,
        punishment: 'delete',
        allowList: [], // guild IDs whose invites are allowed
        strikeWeight: 1,
      },
      links: {
        enabled: false,
        punishment: 'delete',
        allowList: ['youtube.com', 'youtu.be', 'tenor.com', 'giphy.com', 'cdn.discordapp.com'],
        blockList: [],
        strikeWeight: 1,
      },
      words: {
        enabled: false,
        punishment: 'delete',
        words: [],
        allowList: [],
        matchWholeWord: true,
        strikeWeight: 1,
      },
      caps: {
        enabled: true,
        punishment: 'warn',
        minLength: 12,
        thresholdPercent: 70,
        strikeWeight: 1,
      },
      mentions: {
        enabled: true,
        punishment: 'warn',
        maxMentions: 6,
        includeRoleMentions: false,
        strikeWeight: 1,
      },
      emoji: {
        enabled: false,
        punishment: 'delete',
        maxEmoji: 8,
        thresholdPercent: 40,
        strikeWeight: 1,
      },
    },
    escalation: {
      enabled: true,
      windowHours: 24,
      // Ordered ladder. The highest step whose threshold is met is applied.
      steps: [
        { strikes: 3, action: 'mute', duration: '30m' },
        { strikes: 5, action: 'mute', duration: '4h' },
        { strikes: 8, action: 'kick', duration: null },
        { strikes: 12, action: 'ban', duration: null },
      ],
    },
    raid: {
      enabled: true,
      threshold: 8,
      windowSeconds: 30,
      minAccountAgeDays: 7,
      // alert | lockdown
      action: 'alert',
      autoUnlockMinutes: 30,
      lockChannelIds: [],
      lockRoleIds: [],
    },
  };
}

/** Default logging configuration document. */
function defaultLoggingConfig() {
  return {
    channels: {
      modLog: null,
      messageLog: null,
      joinLeaveLog: null,
      voiceLog: null,
      serverLog: null,
      automodLog: null,
    },
    events: buildDefaultLogEvents(),
    ignoreChannelIds: [],
    ignoreBotMessages: true,
  };
}

/** Default scheduled-action settings stored alongside guild config. */
function defaultSchedulerSettings() {
  return {
    defaultTempbanDuration: '7d',
    defaultTempmuteDuration: '1h',
  };
}

module.exports = {
  defaultGuildConfig,
  defaultAutomodConfig,
  defaultLoggingConfig,
  defaultSchedulerSettings,
  buildDefaultLogEvents,
};
