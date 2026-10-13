'use strict';

/**
 * Gateway: the bot's single access point to Cloudflare D1.
 *
 * Cloudflare D1 is not reachable from an external Node process, so every read
 * and write goes through the Worker defined in cloudflare/worker/. This module
 * wraps each endpoint in a small, typed, documented method. Nothing outside of
 * src/db/ should construct URLs or call fetch directly.
 *
 * All identifiers (guild, user, case) are validated as snowflakes or integers
 * before being placed in a path segment.
 */

const { HttpClient } = require('./httpClient');
const { DatabaseError } = require('../utils/errors');
const { toSnowflake, clampInt } = require('../utils/sanitize');
const { logger } = require('../utils/logger');

const log = logger.child('db');

class Gateway {
  /** @param {{worker: {baseUrl: string, authToken: string, timeoutMs: number, maxRetries: number}}} config */
  constructor(config) {
    this.http = new HttpClient(config.worker);
    this.available = this.http.isConfigured();
  }

  /**
   * Assert that a value is a usable Discord snowflake.
   * @param {*} value
   * @param {string} label
   * @returns {string}
   */
  static requireId(value, label) {
    const id = toSnowflake(value);
    if (!id) throw new DatabaseError(`Invalid identifier supplied for ${label}`, { code: 'INVALID_IDENTIFIER' });
    return id;
  }

  // ------------------------------------------------------------------
  // Health
  // ------------------------------------------------------------------

  /** Lightweight readiness probe used at startup. */
  async health() {
    return this.http.get('/health', { retries: 1 });
  }

  /** Persist a startup / heartbeat row so uptime can be observed from D1. */
  async heartbeat(payload) {
    try {
      return await this.http.post('/v1/bot/heartbeat', payload, { retries: 1 });
    } catch (error) {
      log.debug('Heartbeat failed', { code: error.code });
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Guild configuration
  // ------------------------------------------------------------------

  /** Fetch the full guild configuration document. */
  async getGuildConfig(guildId) {
    const id = Gateway.requireId(guildId, 'guildId');
    const result = await this.http.get(`/v1/guilds/${id}/config`);
    return result.config || null;
  }

  /** Merge a partial configuration update into the stored document. */
  async updateGuildConfig(guildId, patch) {
    const id = Gateway.requireId(guildId, 'guildId');
    const result = await this.http.put(`/v1/guilds/${id}/config`, { patch });
    return result.config || null;
  }

  /** Remove all data for a guild (used when the bot is removed from it). */
  async purgeGuild(guildId) {
    const id = Gateway.requireId(guildId, 'guildId');
    return this.http.delete(`/v1/guilds/${id}`);
  }

  /** Aggregate counters for the config and info commands. */
  async getGuildStats(guildId) {
    const id = Gateway.requireId(guildId, 'guildId');
    return this.http.get(`/v1/guilds/${id}/stats`);
  }

  // ------------------------------------------------------------------
  // Automod and logging settings
  // ------------------------------------------------------------------

  /** Fetch the automod configuration document. */
  async getAutomodConfig(guildId) {
    const id = Gateway.requireId(guildId, 'guildId');
    const result = await this.http.get(`/v1/guilds/${id}/automod`);
    return result.automod || null;
  }

  /** Merge a partial automod configuration update. */
  async updateAutomodConfig(guildId, patch) {
    const id = Gateway.requireId(guildId, 'guildId');
    const result = await this.http.put(`/v1/guilds/${id}/automod`, { patch });
    return result.automod || null;
  }

  /** Fetch the logging configuration document. */
  async getLoggingConfig(guildId) {
    const id = Gateway.requireId(guildId, 'guildId');
    const result = await this.http.get(`/v1/guilds/${id}/logging`);
    return result.logging || null;
  }

  /** Merge a partial logging configuration update. */
  async updateLoggingConfig(guildId, patch) {
    const id = Gateway.requireId(guildId, 'guildId');
    const result = await this.http.put(`/v1/guilds/${id}/logging`, { patch });
    return result.logging || null;
  }

  // ------------------------------------------------------------------
  // Cases
  // ------------------------------------------------------------------

  /**
   * Create a case. The gateway allocates the per-guild case number atomically.
   * @param {string} guildId
   * @param {object} data
   */
  async createCase(guildId, data) {
    const id = Gateway.requireId(guildId, 'guildId');
    const result = await this.http.post(`/v1/guilds/${id}/cases`, data);
    return result.case || null;
  }

  /**
   * List cases with optional filters.
   * @param {string} guildId
   * @param {{userId?: string, moderatorId?: string, action?: string, activeOnly?: boolean, page?: number, limit?: number}} filters
   */
  async listCases(guildId, filters = {}) {
    const id = Gateway.requireId(guildId, 'guildId');
    const result = await this.http.get(`/v1/guilds/${id}/cases`, {
      query: {
        userId: filters.userId,
        moderatorId: filters.moderatorId,
        action: filters.action,
        activeOnly: filters.activeOnly ? 'true' : undefined,
        page: clampInt(filters.page, 1, 100000, 1),
        limit: clampInt(filters.limit, 1, 500, 25),
      },
    });
    return { cases: result.cases || [], total: result.total || 0, page: result.page || 1, pages: result.pages || 1 };
  }

  /** Fetch one case by its per-guild number. */
  async getCase(guildId, caseNumber) {
    const id = Gateway.requireId(guildId, 'guildId');
    const number = clampInt(caseNumber, 1, Number.MAX_SAFE_INTEGER, 0);
    if (!number) throw new DatabaseError('Invalid case number', { code: 'INVALID_CASE' });
    const result = await this.http.get(`/v1/guilds/${id}/cases/${number}`);
    return result.case || null;
  }

  /** Update the reason, status, or metadata of an existing case. */
  async updateCase(guildId, caseNumber, patch) {
    const id = Gateway.requireId(guildId, 'guildId');
    const number = clampInt(caseNumber, 1, Number.MAX_SAFE_INTEGER, 0);
    if (!number) throw new DatabaseError('Invalid case number', { code: 'INVALID_CASE' });
    const result = await this.http.patch(`/v1/guilds/${id}/cases/${number}`, patch);
    return result.case || null;
  }

  /** Streamed export rows for the modlog export command. */
  async exportCases(guildId, limit = 1000) {
    const id = Gateway.requireId(guildId, 'guildId');
    const result = await this.http.get(`/v1/guilds/${id}/cases/export`, { query: { limit: clampInt(limit, 1, 5000, 1000) } });
    return result.cases || [];
  }

  // ------------------------------------------------------------------
  // Warnings
  // ------------------------------------------------------------------

  /** List warnings for a user. */
  async listWarnings(guildId, userId, options = {}) {
    const gid = Gateway.requireId(guildId, 'guildId');
    const uid = Gateway.requireId(userId, 'userId');
    const result = await this.http.get(`/v1/guilds/${gid}/warnings`, {
      query: { userId: uid, activeOnly: options.activeOnly ? 'true' : undefined },
    });
    return result.warnings || [];
  }

  /** Count only, for warning-count fields in embeds. */
  async countWarnings(guildId, userId, activeOnly = true) {
    const gid = Gateway.requireId(guildId, 'guildId');
    const uid = Gateway.requireId(userId, 'userId');
    const result = await this.http.get(`/v1/guilds/${gid}/warnings/count`, {
      query: { userId: uid, activeOnly: activeOnly ? 'true' : undefined },
    });
    return { active: result.active || 0, total: result.total || 0 };
  }

  /** Remove a single warning (delwarn). */
  async deleteWarning(guildId, warningId, clearedBy = null) {
    const gid = Gateway.requireId(guildId, 'guildId');
    const wid = clampInt(warningId, 1, Number.MAX_SAFE_INTEGER, 0);
    if (!wid) throw new DatabaseError('Invalid warning id', { code: 'INVALID_WARNING' });
    const result = await this.http.delete(`/v1/guilds/${gid}/warnings/${wid}`, {
      body: { clearedBy: clearedBy || null },
    });
    return result.warning || null;
  }

  /** Edit a warning reason. */
  async updateWarning(guildId, warningId, patch) {
    const gid = Gateway.requireId(guildId, 'guildId');
    const wid = clampInt(warningId, 1, Number.MAX_SAFE_INTEGER, 0);
    if (!wid) throw new DatabaseError('Invalid warning id', { code: 'INVALID_WARNING' });
    const result = await this.http.patch(`/v1/guilds/${gid}/warnings/${wid}`, patch);
    return result.warning || null;
  }

  /** Deactivate every warning for a user. Returns the number cleared. */
  async clearWarnings(guildId, userId, clearedBy = null) {
    const gid = Gateway.requireId(guildId, 'guildId');
    const uid = Gateway.requireId(userId, 'userId');
    const result = await this.http.post(`/v1/guilds/${gid}/warnings/clear`, { userId: uid, clearedBy: clearedBy || null });
    return result.cleared || 0;
  }

  // ------------------------------------------------------------------
  // Notes
  // ------------------------------------------------------------------

  /**
   * Create a private moderator note.
   * @param {string} guildId
   * @param {{userId: string, authorId: string, content: string, caseNumber?: number}} data
   */
  async createNote(guildId, data) {
    const id = Gateway.requireId(guildId, 'guildId');
    const result = await this.http.post(`/v1/guilds/${id}/notes`, data);
    return result.note || null;
  }

  /** List private moderator notes about a user. */
  async listNotes(guildId, userId) {
    const gid = Gateway.requireId(guildId, 'guildId');
    const uid = Gateway.requireId(userId, 'userId');
    const result = await this.http.get(`/v1/guilds/${gid}/notes`, { query: { userId: uid } });
    return result.notes || [];
  }

  /** Delete a note by id. */
  async deleteNote(guildId, noteId) {
    const gid = Gateway.requireId(guildId, 'guildId');
    const nid = clampInt(noteId, 1, Number.MAX_SAFE_INTEGER, 0);
    if (!nid) throw new DatabaseError('Invalid note id', { code: 'INVALID_NOTE' });
    const result = await this.http.delete(`/v1/guilds/${gid}/notes/${nid}`);
    return result.note || null;
  }

  // ------------------------------------------------------------------
  // Punishment state (active mutes, bans, temporary roles)
  // ------------------------------------------------------------------

  /** Record or replace the active punishment row of a given type. */
  async setPunishment(guildId, data) {
    const id = Gateway.requireId(guildId, 'guildId');
    const result = await this.http.post(`/v1/guilds/${id}/punishments`, data);
    return result.punishment || null;
  }

  /** Mark a punishment inactive, optionally with a reason. */
  async clearPunishment(guildId, options) {
    const id = Gateway.requireId(guildId, 'guildId');
    const userId = Gateway.requireId(options.userId, 'userId');
    const result = await this.http.post(`/v1/guilds/${id}/punishments/clear`, {
      userId,
      type: options.type,
      clearedBy: options.clearedBy || null,
      reason: options.reason || null,
    });
    return result.cleared || 0;
  }

  /** Current active punishments for a user (used by whois). */
  async getPunishments(guildId, userId) {
    const gid = Gateway.requireId(guildId, 'guildId');
    const uid = Gateway.requireId(userId, 'userId');
    const result = await this.http.get(`/v1/guilds/${gid}/punishments`, { query: { userId: uid } });
    return result.punishments || [];
  }

  // ------------------------------------------------------------------
  // Automod strikes
  // ------------------------------------------------------------------

  /** Add strike weight for a user and return the new active total. */
  async addStrike(guildId, data) {
    const id = Gateway.requireId(guildId, 'guildId');
    const result = await this.http.post(`/v1/guilds/${id}/strikes`, data);
    return { strikes: result.strikes || 0, recorded: result.recorded || 0 };
  }

  /** Active strike total for a user. */
  async getStrikes(guildId, userId) {
    const gid = Gateway.requireId(guildId, 'guildId');
    const uid = Gateway.requireId(userId, 'userId');
    const result = await this.http.get(`/v1/guilds/${gid}/strikes`, { query: { userId: uid } });
    return result.strikes || 0;
  }

  /** Reset strikes for a user. */
  async resetStrikes(guildId, userId) {
    const gid = Gateway.requireId(guildId, 'guildId');
    const uid = Gateway.requireId(userId, 'userId');
    const result = await this.http.post(`/v1/guilds/${gid}/strikes/reset`, { userId: uid });
    return result.removed || 0;
  }

  // ------------------------------------------------------------------
  // Scheduled tasks
  // ------------------------------------------------------------------

  /** Enqueue a delayed action that survives bot restarts. */
  async createTask(guildId, data) {
    const id = Gateway.requireId(guildId, 'guildId');
    const result = await this.http.post(`/v1/guilds/${id}/tasks`, data);
    return result.task || null;
  }

  /** Claim due tasks across all guilds. Returns rows and marks them running. */
  async claimDueTasks(limit = 25) {
    const result = await this.http.post('/v1/tasks/claim', { limit: clampInt(limit, 1, 100, 25) });
    return result.tasks || [];
  }

  /** Mark a claimed task finished, failed, or cancelled. */
  async completeTask(guildId, taskId, status, lastError = null) {
    const gid = Gateway.requireId(guildId, 'guildId');
    const tid = clampInt(taskId, 1, Number.MAX_SAFE_INTEGER, 0);
    if (!tid) throw new DatabaseError('Invalid task id', { code: 'INVALID_TASK' });
    return this.http.post(`/v1/guilds/${gid}/tasks/${tid}/complete`, { status, lastError });
  }

  /** Cancel pending tasks of a type for a target (e.g. manual unmute). */
  async cancelTasks(guildId, options = {}) {
    const gid = Gateway.requireId(guildId, 'guildId');
    const result = await this.http.post(`/v1/guilds/${gid}/tasks/cancel`, {
      type: options.type,
      targetId: options.targetId ? Gateway.requireId(options.targetId, 'targetId') : null,
      taskId: options.taskId ? clampInt(options.taskId, 1, Number.MAX_SAFE_INTEGER, 0) : null,
    });
    return result.cancelled || 0;
  }

  /** List pending tasks for a user (shown in whois and modlog). */
  async listTasks(guildId, options = {}) {
    const gid = Gateway.requireId(guildId, 'guildId');
    const result = await this.http.get(`/v1/guilds/${gid}/tasks`, {
      query: {
        status: options.status || 'pending',
        targetId: options.targetId ? Gateway.requireId(options.targetId, 'targetId') : undefined,
        type: options.type,
      },
    });
    return result.tasks || [];
  }
}

module.exports = { Gateway };
