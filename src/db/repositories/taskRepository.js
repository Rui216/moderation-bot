'use strict';

/**
 * Scheduled task repository: the durable queue behind every timed action.
 *
 * Tasks are written to D1 when a tempmute, tempban, temprole, or automatic
 * lockdown is applied, so an expiry is never lost when the process restarts on
 * Wispbyte. The scheduler service polls claimDueTasks() on an interval.
 */

const { logger } = require('../../utils/logger');

const log = logger.child('tasks');

let gateway = null;

/** Bound by the data layer during initialisation. */
function attach(instance) {
  gateway = instance;
}

/**
 * Enqueue a task.
 * @param {string} guildId
 * @param {{type: string, targetId?: string|null, runAt: number, payload?: object, caseNumber?: number}} data
 */
async function create(guildId, data) {
  const task = await gateway.createTask(guildId, data);
  log.debug('Task queued', { guildId, type: data.type, runAt: data.runAt });
  return task;
}

/** Claim the next batch of due tasks. */
async function claimDue(limit = 25) {
  return gateway.claimDueTasks(limit);
}

/** Mark a task finished, failed, or cancelled. */
async function complete(guildId, taskId, status, lastError = null) {
  return gateway.completeTask(guildId, taskId, status, lastError);
}

/**
 * Cancel pending tasks matching a filter.
 * @param {string} guildId
 * @param {{type?: string, targetId?: string|null, taskId?: number|null}} options
 */
async function cancel(guildId, options = {}) {
  return gateway.cancelTasks(guildId, options);
}

/** List tasks for a guild, filtered by status/target/type. */
async function list(guildId, options = {}) {
  return gateway.listTasks(guildId, options);
}

/** Pending tasks for one user, used by whois and the modlog command. */
async function listForUser(guildId, userId) {
  return gateway.listTasks(guildId, { status: 'pending', targetId: userId });
}

module.exports = { attach, create, claimDue, complete, cancel, list, listForUser };
