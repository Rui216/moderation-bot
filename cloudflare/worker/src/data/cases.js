/**
 * Case records: the moderation history.
 *
 * Creating a case may also create a linked warning row, a punishment state
 * row, and a scheduled expiry task. Those writes are grouped so a partial
 * action cannot be recorded: warnings, cases, punishments, and expiry tasks
 * are written together in a single transactional D1 batch.
 */

import { all, first, run, batch, nextCounter, StorageError } from '../core/db.js';
import { TASK_TYPES } from './tasks.js';
import {
  requireSnowflake,
  optionalSnowflake,
  requireText,
  text,
  int,
  bool,
  oneOf,
  optionalUrl,
  requireObject,
  toJsonColumn,
  parseJsonColumn,
  nowMs,
} from '../core/validate.js';

/** Actions the bot is allowed to record. */
export const CASE_ACTIONS = [
  'ban', 'tempban', 'unban', 'softban', 'kick', 'mute', 'tempmute', 'unmute',
  'warn', 'delwarn', 'clearwarnings', 'note', 'purge', 'slowmode',
  'lockdown', 'server_lockdown', 'unlock', 'server_unlock',
  'forcenick', 'nicklock', 'addrole', 'removerole', 'temprole',
  'automod', 'raid', 'expiry',
];

/** Case statuses. */
export const CASE_STATUSES = ['active', 'reversed', 'expired', 'completed'];

const CASE_COLUMNS = `
  id, guild_id, case_number, action, status, target_id, moderator_id, reason,
  evidence_url, duration_ms, expires_at, warning_id, channel_id, metadata,
  reversed_at, reversed_by, created_at, updated_at
`;

/** Map a cases row to the API document. */
export function rowToCase(row) {
  if (!row) return null;
  return {
    id: row.id,
    guildId: row.guild_id,
    caseNumber: row.case_number,
    action: row.action,
    status: row.status,
    targetId: row.target_id || null,
    moderatorId: row.moderator_id,
    reason: row.reason || null,
    evidenceUrl: row.evidence_url || null,
    durationMs: row.duration_ms || null,
    expiresAt: row.expires_at || null,
    warningId: row.warning_id || null,
    channelId: row.channel_id || null,
    metadata: parseJsonColumn(row.metadata, {}),
    reversedAt: row.reversed_at || null,
    reversedBy: row.reversed_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Create a case with its optional side effects.
 *
 * @param {object} env
 * @param {string} guildId
 * @param {object} input
 * @returns {Promise<{case: object, warningId: number|null, punishmentId: number|null, taskId: number|null}>}
 */
export async function createCase(env, guildId, input) {
  requireSnowflake(guildId, 'guildId');
  requireObject(input, 'case');

  const action = oneOf(input.action, CASE_ACTIONS, 'action');
  const targetId = optionalSnowflake(input.targetId, 'targetId');
  const moderatorId = !input.moderatorId || input.moderatorId === 'system' ? 'system' : requireSnowflake(input.moderatorId, 'moderatorId');
  const reason = text(input.reason, 500);
  const evidenceUrl = input.evidenceUrl ? optionalUrl(input.evidenceUrl, 'evidenceUrl') : null;
  const durationMs = int(input.durationMs, { min: 0, max: 315360000000, fallback: null });
  const expiresAt = int(input.expiresAt, { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: null });
  const channelId = optionalSnowflake(input.channelId, 'channelId');
  const metadata = toJsonColumn(input.metadata || {});
  const now = nowMs();

  const caseNumber = await nextCounter(env.DB, guildId, 'case');

  // All linked records must be in the SAME D1 transaction. A separately
  // inserted warning could otherwise survive a failed case/punishment write.
  const statements = [];
  const hasWarning = Boolean(input.warning && typeof input.warning === 'object' && targetId);
  if (hasWarning) {
    statements.push(env.DB.prepare(
      `INSERT INTO warnings (guild_id, user_id, moderator_id, reason, case_number, active, expires_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?7)`,
    ).bind(guildId, targetId, moderatorId, reason, caseNumber,
      int(input.warning.expiresAt, { min: 0, fallback: null }), now));
  }

  statements.push(
    env.DB.prepare(
      `INSERT INTO cases (guild_id, case_number, action, status, target_id, moderator_id, reason, evidence_url,
                          duration_ms, expires_at, warning_id, channel_id, metadata, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?6, ?7, ?8, ?9, CASE WHEN ?10 = 1 THEN (SELECT id FROM warnings WHERE guild_id = ?1 AND case_number = ?2 LIMIT 1) ELSE NULL END, ?11, ?12, ?13, ?13)`,
    ).bind(guildId, caseNumber, action, targetId, moderatorId, reason, evidenceUrl,
      durationMs, expiresAt, hasWarning ? 1 : 0, channelId, metadata, now),
  );

  // Optional punishment state row (current mute / ban / temporary role).
  let punishmentId = null;
  if (input.punishment && typeof input.punishment === 'object' && targetId) {
    const type = oneOf(input.punishment.type, ['mute', 'ban', 'role'], 'punishment.type');
    const roleId = optionalSnowflake(input.punishment.roleId, 'punishment.roleId');
    if (type === 'role' && !roleId) throw new StorageError('punishment.roleId is required for role punishments');
    statements.push(
      env.DB.prepare(
        `INSERT INTO punishments (guild_id, user_id, type, role_id, reason, moderator_id, case_number,
                                  active, created_at, expires_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9, ?8)
         ON CONFLICT (guild_id, user_id, type, IFNULL(role_id, ''))
           DO UPDATE SET reason = excluded.reason,
                         moderator_id = excluded.moderator_id,
                         case_number = excluded.case_number,
                         active = 1,
                         created_at = excluded.created_at,
                         expires_at = excluded.expires_at,
                         cleared_at = NULL,
                         cleared_by = NULL,
                         updated_at = excluded.updated_at`,
      ).bind(guildId, targetId, type, roleId, reason, moderatorId, caseNumber, now,
        int(input.punishment.expiresAt, { min: 0, fallback: null })),
    );
  }

  // Optional scheduled expiry task.
  let taskId = null;
  if (input.task && typeof input.task === 'object' && Number.isFinite(int(input.task.runAt, { fallback: null }))) {
    const taskType = oneOf(input.task.type, TASK_TYPES, 'task.type');
    if (taskType) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO scheduled_tasks (guild_id, type, target_id, payload, run_at, status, attempts, max_attempts,
                                        case_number, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, 5, ?6, ?7, ?7)`,
        ).bind(guildId, taskType, optionalSnowflake(input.task.targetId, 'task.targetId') || targetId,
          toJsonColumn(input.task.payload || {}), int(input.task.runAt, { min: 0 }), caseNumber, now),
      );
    }
  }

  await batch(env.DB, statements);

  const row = await first(env.DB, `SELECT ${CASE_COLUMNS} FROM cases WHERE guild_id = ?1 AND case_number = ?2`, [guildId, caseNumber]);

  return {
    case: rowToCase(row),
    warningId: row?.warning_id || null,
    punishmentId,
    taskId,
    caseNumber,
  };
}

/** Fetch a single case by its per-guild number. */
export async function getCase(env, guildId, caseNumber) {
  requireSnowflake(guildId, 'guildId');
  const row = await first(env.DB, `SELECT ${CASE_COLUMNS} FROM cases WHERE guild_id = ?1 AND case_number = ?2`, [guildId, caseNumber]);
  return rowToCase(row);
}

/** Update reason, status, metadata, or evidence of an existing case. */
export async function updateCase(env, guildId, caseNumber, patch) {
  requireSnowflake(guildId, 'guildId');
  requireObject(patch, 'patch');

  const updates = [];
  const params = [];
  const push = (column, value) => {
    params.push(value);
    updates.push(`${column} = ?${params.length}`);
  };

  if (Object.prototype.hasOwnProperty.call(patch, 'reason')) push('reason', text(patch.reason, 500));
  if (Object.prototype.hasOwnProperty.call(patch, 'status')) push('status', oneOf(patch.status, CASE_STATUSES, 'status'));
  if (Object.prototype.hasOwnProperty.call(patch, 'evidenceUrl')) {
    push('evidence_url', patch.evidenceUrl ? optionalUrl(patch.evidenceUrl, 'evidenceUrl') : null);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'metadata')) push('metadata', toJsonColumn(patch.metadata || {}));
  if (Object.prototype.hasOwnProperty.call(patch, 'reversedBy')) {
    push('reversed_by', patch.reversedBy ? requireSnowflake(patch.reversedBy, 'reversedBy') : null);
  }
  if (bool(patch.markReversed, false)) {
    push('status', 'reversed');
    push('reversed_at', nowMs());
  }
  if (Number.isFinite(int(patch.expiresAt, { fallback: null }))) {
    push('expires_at', int(patch.expiresAt, { min: 0 }));
  }

  if (!updates.length) return getCase(env, guildId, caseNumber);

  params.push(nowMs());
  updates.push(`updated_at = ?${params.length}`);
  params.push(guildId);
  const guildPlaceholder = params.length;
  params.push(caseNumber);
  const casePlaceholder = params.length;

  await run(
    env.DB,
    `UPDATE cases SET ${updates.join(', ')} WHERE guild_id = ?${guildPlaceholder} AND case_number = ?${casePlaceholder}`,
    params,
  );
  return getCase(env, guildId, caseNumber);
}

/** List cases with filters and pagination. */
export async function listCases(env, guildId, filters = {}) {
  requireSnowflake(guildId, 'guildId');

  const where = ['guild_id = ?1'];
  const params = [guildId];

  const addFilter = (clause, value) => {
    params.push(value);
    where.push(clause.replace('?n', `?${params.length}`));
  };

  if (filters.userId) addFilter('target_id = ?n', requireSnowflake(filters.userId, 'userId'));
  if (filters.moderatorId) addFilter('moderator_id = ?n', requireSnowflake(filters.moderatorId, 'moderatorId'));
  if (filters.action) addFilter('action = ?n', oneOf(filters.action, CASE_ACTIONS, 'action'));
  if (filters.activeOnly) where.push("status = 'active'");

  const limit = int(filters.limit, { min: 1, max: 500, fallback: 25 });
  const page = int(filters.page, { min: 1, max: 100000, fallback: 1 });
  const offset = (page - 1) * limit;

  const whereSql = where.join(' AND ');

  const [countRow] = await all(env.DB, `SELECT COUNT(*) AS total FROM cases WHERE ${whereSql}`, params);
  const total = countRow ? countRow.total : 0;

  const rows = await all(
    env.DB,
    `SELECT ${CASE_COLUMNS} FROM cases WHERE ${whereSql} ORDER BY case_number DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`,
    [...params, limit, offset],
  );

  return {
    cases: rows.map(rowToCase),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    limit,
  };
}

/** Export cases for the modlog backup command. */
export async function exportCases(env, guildId, limit = 1000) {
  requireSnowflake(guildId, 'guildId');
  const bounded = int(limit, { min: 1, max: 5000, fallback: 1000 });
  const rows = await all(
    env.DB,
    `SELECT ${CASE_COLUMNS} FROM cases WHERE guild_id = ?1 ORDER BY case_number ASC LIMIT ?2`,
    [guildId, bounded],
  );
  return rows.map(rowToCase);
}
