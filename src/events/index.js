'use strict';

/**
 * Event registration.
 *
 * Every listener is registered here so the set of subscriptions is visible in
 * one place. Handlers themselves live in the sibling modules, grouped by the
 * domain they cover.
 */

const messageCreate = require('./messageCreate');
const interactionCreate = require('./interactionCreate');
const messageEvents = require('./messageEvents');
const memberEvents = require('./memberEvents');
const voiceEvents = require('./voiceEvents');
const serverEvents = require('./serverEvents');
const guildEvents = require('./guildEvents');
const errorEvents = require('./errorEvents');

/**
 * Attach every listener to the client.
 * @param {import('discord.js').Client} client
 * @param {object} deps { appConfig, limits }
 */
function registerAll(client, deps) {
  messageCreate.register(client, deps);
  interactionCreate.register(client, deps);
  messageEvents.register(client, deps);
  memberEvents.register(client, deps);
  voiceEvents.register(client, deps);
  serverEvents.register(client, deps);
  guildEvents.register(client, deps);
  errorEvents.register(client, deps.appConfig);
}

module.exports = { registerAll };
