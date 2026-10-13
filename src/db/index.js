'use strict';

/**
 * Database access entry point.
 *
 * The bot owns no local database. Every persisted value lives in Cloudflare D1
 * and is reached exclusively through the Worker gateway. This module creates
 * the single gateway instance and exposes the repositories built on top of it.
 */

const { Gateway } = require('./gateway');
const { logger } = require('../utils/logger');

const log = logger.child('db');

let gateway = null;
const repositories = {};

/**
 * Initialise the data layer. Safe to call once at startup.
 * @param {object} config application configuration
 */
function initDatabase(config) {
  gateway = new Gateway(config);

  // Required lazily so a missing configuration never crashes at import time.
  repositories.guilds = require('./repositories/guildRepository');
  repositories.cases = require('./repositories/caseRepository');
  repositories.warnings = require('./repositories/warningRepository');
  repositories.notes = require('./repositories/noteRepository');
  repositories.punishments = require('./repositories/punishmentRepository');
  repositories.tasks = require('./repositories/taskRepository');

  for (const repository of Object.values(repositories)) {
    if (typeof repository.attach === 'function') repository.attach(gateway);
  }

  log.info('Data layer initialised', { gatewayConfigured: gateway.available });
  return gateway;
}

/** The active gateway instance. Throws when accessed before initialisation. */
function getGateway() {
  if (!gateway) throw new Error('Database layer accessed before initialisation');
  return gateway;
}

/** Named repository accessor. */
function repo(name) {
  if (!repositories[name]) throw new Error(`Unknown repository requested: ${name}`);
  return repositories[name];
}

module.exports = { initDatabase, getGateway, repo };
