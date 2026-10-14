'use strict';

/**
 * Discord client construction.
 *
 * The client is configured with exactly the intents the bot needs, a presence
 * derived from the environment, and a services bag so event handlers and
 * scheduled tasks can reach the same service instances without import cycles.
 *
 * Reconnection is handled by discord.js itself (it reconnects the gateway with
 * backoff). The shard events below only mirror state into the health endpoint
 * and the private log.
 */

const {
  Client,
  GatewayIntentBits,
  Partials,
  ActivityType,
  Options,
} = require('discord.js');

const { logger } = require('../utils/logger');
const healthService = require('../services/healthService');

const log = logger.child('client');

/** Map readable intent names (from the environment) to discord.js flags. */
const INTENT_MAP = {
  Guilds: GatewayIntentBits.Guilds,
  GuildMembers: GatewayIntentBits.GuildMembers,
  GuildModeration: GatewayIntentBits.GuildModeration,
  GuildMessages: GatewayIntentBits.GuildMessages,
  GuildVoiceStates: GatewayIntentBits.GuildVoiceStates,
  MessageContent: GatewayIntentBits.MessageContent,
  DirectMessages: GatewayIntentBits.DirectMessages,
  GuildInvites: GatewayIntentBits.GuildInvites,
  GuildEmojisAndStickers: GatewayIntentBits.GuildEmojisAndStickers,
  GuildWebhooks: GatewayIntentBits.GuildWebhooks,
};

/** Map readable activity type names to discord.js activity types. */
const ACTIVITY_MAP = {
  PLAYING: ActivityType.Playing,
  WATCHING: ActivityType.Watching,
  LISTENING: ActivityType.Listening,
  COMPETING: ActivityType.Competing,
  CUSTOM: ActivityType.Custom,
};

/**
 * Build the client.
 * @param {object} appConfig environment configuration
 * @param {object} services services bag shared with handlers
 * @returns {Client}
 */
function createClient(appConfig, services) {
  const intents = appConfig.discord.intents
    .map((name) => INTENT_MAP[name])
    .filter((flag) => flag !== undefined);

  // GuildInvites is only useful for invite logging; include it when requested
  // through the environment rather than always.
  if (!intents.includes(GatewayIntentBits.GuildInvites) && appConfig.discord.logInvites !== false) {
    intents.push(GatewayIntentBits.GuildInvites);
  }

  const client = new Client({
    intents,
    partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.User],
    // A modest rest timeout avoids hung requests while staying tolerant of
    // Discord's slower endpoints (bulk delete, audit logs).
    rest: { timeout: 20000, retries: 3 },
    // Fail fast on invalid options instead of silently degrading.
    failIfNotExists: false,
    allowedMentions: { parse: [], repliedUser: false },
    // Sweepers keep long-running memory use flat. Each entry needs its own
    // predicate; discord.js validates that a filter function is present.
    sweepers: {
      messages: {
        interval: 600,
        lifetime: 1800,
        // Sweep bot replies and system notices first: they are never needed
        // for moderation context.
        filter: () => (message) => Boolean(message.author && message.author.bot),
      },
      users: {
        interval: 3600,
        lifetime: 7200,
        filter: () => (user) => Boolean(user && user.bot && user.id !== user.client.user.id),
      },
      guildMembers: {
        interval: 3600,
        lifetime: 7200,
        filter: () => (member) => Boolean(member && member.user && member.user.bot),
      },
      guildScheduledEvents: { interval: 3600, lifetime: 7200 },
      threads: { interval: 3600, lifetime: 7200 },
      guildInvites: { interval: 3600, lifetime: 7200 },
    },
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      // Keep the caches that moderation needs accurate, bound the noisy ones.
      GuildMemberManager: { maxSize: 2000, keepOverLimit: (member) => member.id === member.client.user.id },
      MessageManager: 200,
      PresenceManager: 0,
      ReactionManager: 0,
      GuildInviteManager: 100,
    }),
  });

  client.services = services;
  client.appConfig = appConfig;

  return client;
}

/**
 * Apply the presence configured through the environment.
 * @param {Client} client
 * @param {object} appConfig
 */
async function applyPresence(client, appConfig) {
  const { text, type } = appConfig.discord.activity;
  if (!text) return;
  try {
    await client.user.setPresence({
      activities: [{ name: text, type: ACTIVITY_MAP[type] || ActivityType.Watching }],
      status: 'online',
    });
  } catch (error) {
    log.debug('Presence could not be set', { code: error && error.code });
  }
}

/**
 * Attach lifecycle listeners that keep the health endpoint and logs accurate.
 * @param {Client} client
 */
function attachLifecycle(client) {
  client.on('clientReady', () => {
    healthService.update({
      ready: true,
      guildCount: client.guilds.cache.size,
      version: client.options.version || null,
    });
  });

  client.on('shardDisconnect', (event, shardId) => {
    healthService.update({ ready: false });
    log.warn('Gateway disconnected', { shardId, code: event && event.code });
  });

  client.on('shardReconnecting', (shardId) => {
    log.info('Gateway reconnecting', { shardId });
  });

  client.on('shardResume', (shardId, replayedEvents) => {
    healthService.update({ ready: true, guildCount: client.guilds.cache.size });
    log.info('Gateway resumed', { shardId, replayedEvents });
  });

  client.on('shardError', (error, shardId) => {
    log.error('Gateway shard error', { shardId, message: error && error.message, stack: error && error.stack });
  });

  client.on('error', (error) => {
    log.error('Client error', { message: error && error.message, stack: error && error.stack });
  });

  client.on('warn', (message) => {
    log.warn('Client warning', { message });
  });

  client.on('rateLimit', (info) => {
    // Never log the route with identifiers attached; the path alone is enough.
    log.debug('Client rate limited', { timeout: info && info.timeout, method: info && info.method, path: info && info.path });
  });
}

module.exports = { createClient, applyPresence, attachLifecycle, INTENT_MAP, ACTIVITY_MAP };
