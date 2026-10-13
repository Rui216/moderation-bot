/**
 * Durable scheduled task queue.
 *
 * Temporary punishments (tempmute, tempban, temprole), automatic lockdown
 * expiry, and warning expiry all become rows here. The bot polls for due rows,
 * claims them, performs the Discord action, and marks the row done. Because the
 * queue lives in D1, a restart on Wispbyte never loses a pending expiry.
 *
 * Claiming is a single UPDATE ... RETURNING statement, so two bot instances
 * cannot execute the same task.
 */

import { all, first, run, insertReturningId, StorageError } from '../core/db.js';
import {
  requireSnowflake,
  optionalSnowflake,
  text,
  int,
  oneOf,
  requireObject,
  toJsonColumn,
  parseJsonColumn,
  nowMs,
} from '../core/validate.js';

/** Task types the bot understands. */
export const TASK_TYPES = ['unmute', 'unban', 'unlock', 'unlock_server', 'remove_role', 'expire_warnings'];

/** Task lifecycle states. */
export const TASK_STATUSES = ['pending', 'running', 'done', 'failed', 'cancelled'];

const TASK_COLUMNS = `id, guild_id, type, target_id, payload, run_at, status, attempts, max_attempts, last_error, case_number, claimed_at, completed_at, created_at, updated_at`;

/** Map a scheduled_tasks row to the API document. */
export function rowToTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    guildId: row.guild_id,
    type: row.type,
    targetId: row.target_id || null,
    payload: parseJsonColumn(row.payload, {}),
    runAt: row.run_at,
    status: row.status,
    attempts: row.attempts || 0,
    maxAttempts: row.max_attempts || 5,
    lastError: row.last_error || null,
    caseNumber: row.case_number || null,
    claimedAt: row.claimed_at || null,
    completedAt: row.completed_at || null,
    createdAt: row.created_at,
  };
}

/** Enqueue a task. */
export async function createTask(env, guildId, input = {}) {
  requireSnowflake(guildId, 'guildId');
  requireObject(input, 'task');

  const type = oneOf(input.type, TASK_TYPES, 'type');
  const runAt = int(input.runAt, { min: 0, fallback: null });
  if (runAt === null) throw new StorageError('runAt is required');

  const now = nowMs();
  const id = await insertReturningId(
    env.DB,
    `INSERT INTO scheduled_tasks (guild_id, type, target_id, payload, run_at, status, attempts, max_attempts, case_number, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6, ?7, ?8, ?8)`,
    [guildId, type, optionalSnowflake(input.targetId, 'targetId'), toJsonColumn(input.payload || {}), runAt,
      int(input.maxAttempts, { min: 1, max: 20, fallback: 5 }), int(input.caseNumber, { min: 0, fallback: null }), now],
  );

  const row = await first(env.DB, `SELECT ${TASK_COLUMNS} FROM scheduled_tasks WHERE id = ?1`, [id]);
  return rowToTask(row);
}

/**
 * Claim due tasks for execution.
 *
 * Also reclaims rows stuck in "running": if the bot was killed mid-task the row
 * would otherwise never be retried. Rows past max_attempts are failed instead
 * of retried so a permanently broken task cannot loop forever.
 *
 * @param {number} limit maximum tasks to claim
 * @param {number} staleSeconds how long a running row may stay claimed
 */
export async function claimDueTasks(env, limit = 25, staleSeconds = 300) {
  const now = nowMs();
  const staleCutoff = now - Math.max(30, staleSeconds) * 1000;

  const rows = await all(
    env.DB,
    `UPDATE scheduled_tasks
     SET status = 'running', claimed_at = ?1, attempts = attempts + 1, updated_at = ?1
     WHERE id IN (
       SELECT id FROM scheduled_tasks
       WHERE (status = 'pending' AND run_at <= ?1)
          OR (status = 'running' AND claimed_at IS NOT NULL AND claimed_at <= ?2)
       ORDER BY run_at ASC
       LIMIT ?3
     )
     RETURNING ${TASK_COLUMNS}`,
    [now, staleCutoff, int(limit, { min: 1, max: 100, fallback: 25 })],
  );

  const claimed = [];
  for (const row of rows) {
    if (row.attempts > row.max_attempts) {
      await run(
        env.DB,
        "UPDATE scheduled_tasks SET status = 'failed', last_error = ?1, completed_at = ?2, updated_at = ?2 WHERE id = ?3",
        ['Retry limit exceeded', now, row.id],
      );
      continue;
    }
    claimed.push(rowToTask(row));
  }

  return claimed;
}

/** Mark a claimed task finished or failed. */
export async function completeTask(env, guildId, taskId, status, lastError = null) {
  requireSnowflake(guildId, 'guildId');
  const finalStatus = oneOf(status, ['done', 'failed', 'cancelled', 'pending'], 'status');
  const now = nowMs();

  const meta = await run(
    env.DB,
    `UPDATE scheduled_tasks
     SET status = ?1, last_error = ?2, completed_at = CASE WHEN ?1 IN ('done', 'cancelled') THEN ?3 ELSE completed_at END, updated_at = ?3
     WHERE id = ?4 AND guild_id = ?5`,
    [finalStatus, lastError ? text(lastError, 300) : null, now, taskId, guildId],
  );

  return { updated: meta.changes || 0 };
}

/** Cancel pending tasks, filtered by type, target, or exact task id. */
export async function cancelTasks(env, guildId, input = {}) {
  requireSnowflake(guildId, 'guildId');

  const params = [nowMs(), guildId];
  let sql = "UPDATE scheduled_tasks SET status = 'cancelled', completed_at = ?1, updated_at = ?1 WHERE guild_id = ?2 AND status IN ('pending', 'running')";

  if (input.type) {
    params.push(oneOf(input.type, TASK_TYPES, 'type'));
    sql += ` AND type = ?${params.length}`;
  }
  if (input.targetId) {
    params.push(requireSnowflake(input.targetId, 'targetId'));
    sql += ` AND target_id = ?${params.length}`;
  }
  if (input.taskId) {
    params.push(int(input.taskId, { min: 1 }));
    sql += ` AND id = ?${params.length}`;
  }

  const meta = await run(env.DB, sql, params);
  return { cancelled: meta.changes || 0 };
}

/** List tasks for a guild, optionally filtered. */
export async function listTasks(env, guildId, filters = {}) {
  requireSnowflake(guildId, 'guildId');
  const params = [guildId];
  const where = ['guild_id = ?1'];

  if (filters.status) {
    params.push(oneOf(filters.status, TASK_STATUSES, 'status'));
    where.push(`status = ?${params.length}`);
  }
  if (filters.targetId) {
    params.push(requireSnowflake(filters.targetId, 'targetId'));
    where.push(`target_id = ?${params.length}`);
  }
  if (filters.type) {
    params.push(oneOf(filters.type, TASK_TYPES, 'type'));
    where.push(`type = ?${params.length}`);
  }

  const rows = await all(
    env.DB,
    `SELECT ${TASK_COLUMNS} FROM scheduled_tasks WHERE ${where.join(' AND ')} ORDER BY run_at ASC LIMIT 200`,
    params,
  );
  return rows.map(rowToTask);
}

/** Queue depth by status, used by the health endpoint. */
export async function taskSummary(env) {
  const rows = await all(
    env.DB,
    `SELECT status, COUNT(*) AS total FROM scheduled_tasks GROUP BY status`,
  );
  const summary = { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
  for (const row of rows) summary[row.status] = row.total;
  return summary;
}
