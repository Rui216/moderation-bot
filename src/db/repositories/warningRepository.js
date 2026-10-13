'use strict';

/**
 * Warning repository: individual, clearable, optionally expiring warnings.
 */

let gateway = null;

/** Bound by the data layer during initialisation. */
function attach(instance) {
  gateway = instance;
}

/** List warnings for a user. */
async function list(guildId, userId, options = {}) {
  return gateway.listWarnings(guildId, userId, options);
}

/** Count active and total warnings for a user. */
async function count(guildId, userId, activeOnly = true) {
  return gateway.countWarnings(guildId, userId, activeOnly);
}

/** Remove a warning by its database id. */
async function remove(guildId, warningId, clearedBy = null) {
  return gateway.deleteWarning(guildId, warningId, clearedBy);
}

/** Edit a warning reason or expiry. */
async function update(guildId, warningId, patch) {
  return gateway.updateWarning(guildId, warningId, patch);
}

/** Deactivate every active warning for a user. */
async function clearAll(guildId, userId, clearedBy = null) {
  return gateway.clearWarnings(guildId, userId, clearedBy);
}

module.exports = { attach, list, count, remove, update, clearAll };
