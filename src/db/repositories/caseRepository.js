'use strict';

/**
 * Case repository: creation and lookup of moderation cases.
 *
 * A case is the canonical record of a moderation action. Commands build a
 * payload describing the action plus any side effects (warning row, punishment
 * state, expiry task) and hand it to the case service, which calls create().
 */

const { logger } = require('../../utils/logger');

const log = logger.child('cases');

let gateway = null;

/** Bound by the data layer during initialisation. */
function attach(instance) {
  gateway = instance;
}

/**
 * Create a case.
 *
 * @param {string} guildId
 * @param {object} payload
 * @param {string} payload.action          case action key, e.g. "ban"
 * @param {string} [payload.targetId]      user the action applies to
 * @param {string} payload.moderatorId     moderator id, or "system"
 * @param {string} [payload.reason]
 * @param {string} [payload.evidenceUrl]
 * @param {number} [payload.durationMs]
 * @param {number} [payload.expiresAt]
 * @param {string} [payload.channelId]
 * @param {object} [payload.metadata]
 * @param {{expiresAt: number|null}} [payload.warning]
 * @param {{type: string, roleId?: string, expiresAt?: number|null}} [payload.punishment]
 * @param {{type: string, runAt: number, payload?: object}} [payload.task]
 * @returns {Promise<{caseNumber: number, case: object, warningId: number|null}>}
 */
async function create(guildId, payload) {
  const result = await gateway.createCase(guildId, payload);
  log.debug('Case created', { guildId, caseNumber: result.caseNumber, action: payload.action });
  return result;
}

/** Fetch a single case by its number. */
async function get(guildId, caseNumber) {
  return gateway.getCase(guildId, caseNumber);
}

/**
 * List cases.
 * @param {string} guildId
 * @param {{userId?: string, action?: string, activeOnly?: boolean, page?: number, limit?: number}} filters
 */
async function list(guildId, filters = {}) {
  return gateway.listCases(guildId, filters);
}

/** Update a case (reason, status, evidence, metadata). */
async function update(guildId, caseNumber, patch) {
  return gateway.updateCase(guildId, caseNumber, patch);
}

/** Mark a case reversed (used by unban and manual unmute). */
async function markReversed(guildId, caseNumber, reversedBy, reason) {
  return gateway.updateCase(guildId, caseNumber, {
    markReversed: true,
    reversedBy,
    ...(reason ? { reason } : {}),
  });
}

/** Export cases for backup. */
async function exportAll(guildId, limit = 1000) {
  return gateway.exportCases(guildId, limit);
}

module.exports = { attach, create, get, list, update, markReversed, exportAll };
