'use strict';

/**
 * Scheduled action worker.
 *
 * Polls the durable task queue in Cloudflare D1 and executes whatever is due:
 * unmutes, unbans, temporary role removals, lockdown expiry, and warning
 * expiry. Because the queue lives in the database, a restart on Wispbyte never
 * loses a pending expiry - the next poll simply picks the row up again.
 *
 * Claiming is atomic on the gateway side, so a task is never executed twice
 * even if a poll overlaps with a slow previous run.
 */

const { TASK_TYPES, TASK_STATUS } = require('../config/constants');
const { logger } = require('../utils/logger');
const { repo } = require('../db');

const log = logger.child('scheduler');

let timer = null;
let running = false;
let stopped = true;
let currentIntervalMs = 30000;
let currentBatchSize = 25;

/**
 * Build a command context for a system-initiated action. There is no
 * moderator member, so the pipeline records "system" as the actor.
 */
function systemContext(guild, config, limits) {
  return {
    guild,
    config,
    moderator: null,
    client: guild.client,
    limits,
    rawReason: 'Scheduled task',
  };
}

/**
 * Execute one claimed task.
 *
 * @param {object} task task document from the gateway
 * @param {object} deps { client, limits }
 * @returns {Promise<{status: string, error?: string}>}
 */
async function executeTask(task, deps) {
  const { client, limits } = deps;
  const guild = client.guilds.cache.get(task.guildId);
  if (!guild) return { status: TASK_STATUS.CANCELLED, error: 'Guild is no longer available' };

  const config = await repo('guilds').getConfig(guild.id).catch(() => null);
  const ctx = systemContext(guild, config, limits);
  const payload = task.payload || {};

  switch (task.type) {
    case TASK_TYPES.UNMUTE: {
      const member = await guild.members.fetch(task.targetId).catch(() => null);
      if (!member) {
        await repo('punishments').clear(guild.id, { userId: task.targetId, type: 'mute', clearedBy: null, reason: 'Member left the server' });
        return { status: TASK_STATUS.DONE };
      }
      if (!member.isCommunicationDisabled || !member.isCommunicationDisabled()) {
        await repo('punishments').clear(guild.id, { userId: task.targetId, type: 'mute', clearedBy: null, reason: 'Mute already expired' });
        return { status: TASK_STATUS.DONE };
      }
      await client.services.punishmentService.unmute(ctx, member, {
        reason: payload.reason || 'Temporary mute expired',
        system: true,
        caseNumber: task.caseNumber,
      });
      return { status: TASK_STATUS.DONE };
    }

    case TASK_TYPES.UNBAN: {
      const user = await client.users.fetch(task.targetId).catch(() => null);
      if (!user) {
        await repo('punishments').clear(guild.id, { userId: task.targetId, type: 'ban', clearedBy: null, reason: 'User could not be resolved' });
        return { status: TASK_STATUS.DONE };
      }
      const banned = await guild.bans.fetch(user.id).catch(() => null);
      if (!banned) {
        await repo('punishments').clear(guild.id, { userId: task.targetId, type: 'ban', clearedBy: null, reason: 'Ban already lifted' });
        return { status: TASK_STATUS.DONE };
      }
      await client.services.punishmentService.unban(ctx, user, {
        reason: payload.reason || 'Temporary ban expired',
        system: true,
        caseNumber: task.caseNumber,
      });
      return { status: TASK_STATUS.DONE };
    }

    case TASK_TYPES.REMOVE_ROLE: {
      const member = await guild.members.fetch(task.targetId).catch(() => null);
      const role = payload.roleId ? await guild.roles.fetch(payload.roleId).catch(() => null) : null;
      if (!member || !role || !member.roles.cache.has(role.id)) {
        await repo('punishments').clear(guild.id, { userId: task.targetId, type: 'role', clearedBy: null, reason: 'Temporary role no longer applied' });
        return { status: TASK_STATUS.DONE };
      }
      await client.services.punishmentService.expireTempRole(guild, member, role, {
        reason: payload.reason || 'Temporary role expired',
        caseNumber: task.caseNumber,
      });
      return { status: TASK_STATUS.DONE };
    }

    case TASK_TYPES.UNLOCK: {
      const channel = task.targetId ? guild.channels.cache.get(task.targetId) : null;
      if (!channel) return { status: TASK_STATUS.CANCELLED, error: 'Channel no longer exists' };
      await client.services.channelService.unlock(ctx, channel, { system: true });
      return { status: TASK_STATUS.DONE };
    }

    case TASK_TYPES.UNLOCK_SERVER: {
      const channelIds = Array.isArray(payload.channelIds) && payload.channelIds.length > 0 ? payload.channelIds : null;
      await client.services.channelService.unlock(ctx, null, { system: true, channelIds });
      return { status: TASK_STATUS.DONE };
    }

    case TASK_TYPES.EXPIRE_WARNINGS: {
      // Warning expiry is evaluated lazily on read, so the task only records
      // that the sweep ran for this user.
      await repo('warnings').list(guild.id, task.targetId, { activeOnly: true });
      return { status: TASK_STATUS.DONE };
    }

    default:
      return { status: TASK_STATUS.FAILED, error: 'Unsupported task type' };
  }
}

/** Claim and run one batch. Safe to call concurrently: guarded by `running`. */
async function runOnce(deps) {
  if (running) return { claimed: 0, executed: 0 };
  running = true;

  try {
    const tasks = await repo('tasks').claimDue(currentBatchSize);
    if (tasks.length === 0) return { claimed: 0, executed: 0 };

    let executed = 0;
    for (const task of tasks) {
      try {
        const result = await executeTask(task, deps);
        await repo('tasks').complete(task.guildId, task.id, result.status, result.error || null);
        if (result.status === TASK_STATUS.DONE) executed += 1;
      } catch (error) {
        const message = error && error.code ? String(error.code) : 'execution failed';
        log.warn('Scheduled task failed', { type: task.type, guildId: task.guildId, code: error && error.code });
        await repo('tasks').complete(task.guildId, task.id, TASK_STATUS.FAILED, message).catch(() => null);
      }
    }

    log.debug('Scheduler batch complete', { claimed: tasks.length, executed });
    return { claimed: tasks.length, executed };
  } catch (error) {
    log.warn('Scheduler poll failed', { code: error && error.code });
    return { claimed: 0, executed: 0 };
  } finally {
    running = false;
  }
}

/**
 * Start the polling loop.
 * @param {object} appConfig environment configuration
 * @param {object} deps { client, limits }
 */
function start(appConfig, deps) {
  if (!appConfig.scheduler.enabled) {
    log.info('Scheduler disabled by configuration');
    return;
  }

  currentIntervalMs = appConfig.scheduler.intervalMs;
  currentBatchSize = appConfig.scheduler.batchSize;
  stopped = false;

  const delay = Math.max(1000, appConfig.scheduler.startupGraceMs);
  log.info('Scheduler started', { intervalMs: currentIntervalMs, batchSize: currentBatchSize });

  timer = setInterval(() => {
    if (stopped) return;
    void runOnce(deps);
  }, currentIntervalMs);
  if (timer.unref) timer.unref();

  // First pass shortly after startup so expiries missed during downtime run soon.
  const initial = setTimeout(() => {
    if (!stopped) void runOnce(deps);
  }, delay);
  if (initial.unref) initial.unref();
}

/** Stop the polling loop. */
function stop() {
  stopped = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Diagnostics for the status command. */
function status() {
  return { running: !stopped, intervalMs: currentIntervalMs, batchSize: currentBatchSize };
}

module.exports = { start, stop, runOnce, executeTask, status, systemContext };
