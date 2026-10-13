'use strict';

/**
 * Punishment repository: the current applied state for each user plus the
 * automod strike counters that drive escalation.
 *
 * The case history records what happened; this table answers "what is applied
 * right now", which the unmute, unban, and expiry paths need.
 */

let gateway = null;

/** Bound by the data layer during initialisation. */
function attach(instance) {
  gateway = instance;
}

/**
 * Record or refresh an active punishment.
 * @param {string} guildId
 * @param {{userId: string, type: 'mute'|'ban'|'role', roleId?: string|null, reason?: string,
 *          moderatorId?: string|null, caseNumber?: number|null, expiresAt?: number|null}} data
 */
async function set(guildId, data) {
  return gateway.setPunishment(guildId, data);
}

/**
 * Clear active punishments.
 * @param {string} guildId
 * @param {{userId: string, type?: string, clearedBy?: string|null, reason?: string|null}} options
 */
async function clear(guildId, options) {
  return gateway.clearPunishment(guildId, options);
}

/** Active punishments for a user. */
async function list(guildId, userId) {
  return gateway.getPunishments(guildId, userId);
}

/** Record an automod strike and return the new active total. */
async function addStrike(guildId, data) {
  return gateway.addStrike(guildId, data);
}

/** Active strike total for a user. */
async function getStrikes(guildId, userId) {
  return gateway.getStrikes(guildId, userId);
}

/** Remove all strikes for a user. */
async function resetStrikes(guildId, userId) {
  return gateway.resetStrikes(guildId, userId);
}

module.exports = { attach, set, clear, list, addStrike, getStrikes, resetStrikes };
