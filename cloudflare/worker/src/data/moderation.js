/**
 * Warnings, private notes, punishment state, and automod strikes.
 *
 * These are the supporting records behind the case history: warnings are
 * clearable and can expire, notes are staff-only, punishments track what is
 * currently applied to a user, and strikes feed the escalation ladder.
 */

import { all, first, insertReturningId, run, StorageError } from '../core/db.js';
import {
  requireSnowflake,
  optionalSnowflake,
  text,
  int,
  toJsonColumn,
  parseJsonColumn,
  nowMs,
  oneOf,
} from '../core/validate.js';

const WARNING_COLUMNS = `id, guild_id, user_id, moderator_id, reason, case_number, active, expires_at, cleared_at, cleared_by, created_at, updated_at`;
const NOTE_COLUMNS = `id, guild_id, user_id, author_id, content, case_number, active, created_at, updated_at`;
const PUNISHMENT_COLUMNS = `id, guild_id, user_id, type, role_id, reason, moderator_id, case_number, active, created_at, expires_at, cleared_at, cleared_by, updated_at`;

/** Map a warnings row to the API document. */
export function rowToWarning(row) {
  if (!row) return null;
  return {
    id: row.id,
    guildId: row.guild_id,
    userId: row.user_id,
    moderatorId: row.moderator_id,
    reason: row.reason || null,
    caseNumber: row.case_number || null,
    active: Boolean(row.active),
    expiresAt: row.expires_at || null,
    clearedAt: row.cleared_at || null,
    clearedBy: row.cleared_by || null,
    createdAt: row.created_at,
  };
}

/** Map a notes row to the API document. */
export function rowToNote(row) {
  if (!row) return null;
  return {
    id: row.id,
    guildId: row.guild_id,
    userId: row.user_id,
    authorId: row.author_id,
    content: row.content,
    caseNumber: row.case_number || null,
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Map a punishments row to the API document. */
export function rowToPunishment(row) {
  if (!row) return null;
  return {
    id: row.id,
    guildId: row.guild_id,
    userId: row.user_id,
    type: row.type,
    roleId: row.role_id || null,
    reason: row.reason || null,
    moderatorId: row.moderator_id || null,
    caseNumber: row.case_number || null,
    active: Boolean(row.active),
    createdAt: row.created_at,
    expiresAt: row.expires_at || null,
    clearedAt: row.cleared_at || null,
    clearedBy: row.cleared_by || null,
  };
}

/* ------------------------------------------------------------------ warnings */

/**
 * List warnings for a user.
 * Expired warnings are deactivated lazily on read so the active count stays
 * accurate without a background job.
 */
export async function listWarnings(env, guildId, userId, { activeOnly = false } = {}) {
  requireSnowflake(guildId, 'guildId');
  requireSnowflake(userId, 'userId');

  const now = nowMs();
  await run(
    env.DB,
    `UPDATE warnings SET active = 0, updated_at = ?1
     WHERE guild_id = ?2 AND user_id = ?3 AND active = 1 AND expires_at IS NOT NULL AND expires_at <= ?1`,
    [now, guildId, userId],
  );

  const rows = await all(
    env.DB,
    `SELECT ${WARNING_COLUMNS} FROM warnings
     WHERE guild_id = ?1 AND user_id = ?2 ${activeOnly ? 'AND active = 1' : ''}
     ORDER BY created_at DESC LIMIT 200`,
    [guildId, userId],
  );
  return rows.map(rowToWarning);
}

/** Count warnings for a user, active and total. */
export async function countWarnings(env, guildId, userId, { activeOnly = true } = {}) {
  requireSnowflake(guildId, 'guildId');
  requireSnowflake(userId, 'userId');
  const now = nowMs();

  const where = activeOnly
    ? 'guild_id = ?1 AND user_id = ?2 AND active = 1 AND (expires_at IS NULL OR expires_at > ?3)'
    : 'guild_id = ?1 AND user_id = ?2';
  const params = activeOnly ? [guildId, userId, now] : [guildId, userId];

  const [row] = await all(env.DB, `SELECT COUNT(*) AS total FROM warnings WHERE ${where}`, params);
  const [totalRow] = await all(env.DB, 'SELECT COUNT(*) AS total FROM warnings WHERE guild_id = ?1 AND user_id = ?2', [guildId, userId]);

  return { active: row ? row.total : 0, total: totalRow ? totalRow.total : 0 };
}

/** Deactivate one warning (delwarn). */
export async function deleteWarning(env, guildId, warningId, clearedBy = null) {
  requireSnowflake(guildId, 'guildId');
  const existing = await first(env.DB, `SELECT ${WARNING_COLUMNS} FROM warnings WHERE guild_id = ?1 AND id = ?2`, [guildId, warningId]);
  if (!existing) return null;

  await run(
    env.DB,
    'UPDATE warnings SET active = 0, cleared_at = ?1, cleared_by = ?2, updated_at = ?1 WHERE guild_id = ?3 AND id = ?4',
    [nowMs(), clearedBy ? optionalSnowflake(clearedBy, 'clearedBy') : null, guildId, warningId],
  );
  return rowToWarning(existing);
}

/** Edit a warning reason. */
export async function updateWarning(env, guildId, warningId, patch = {}) {
  requireSnowflake(guildId, 'guildId');
  const updates = [];
  const params = [];

  if (Object.prototype.hasOwnProperty.call(patch, 'reason')) {
    params.push(text(patch.reason, 500));
    updates.push(`reason = ?${params.length}`);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'expiresAt')) {
    params.push(int(patch.expiresAt, { min: 0, fallback: null }));
    updates.push(`expires_at = ?${params.length}`);
  }
  if (!updates.length) return null;

  params.push(nowMs());
  updates.push(`updated_at = ?${params.length}`);
  params.push(guildId);
  params.push(warningId);

  await run(env.DB, `UPDATE warnings SET ${updates.join(', ')} WHERE guild_id = ?${params.length - 1} AND id = ?${params.length}`, params);
  const row = await first(env.DB, `SELECT ${WARNING_COLUMNS} FROM warnings WHERE guild_id = ?1 AND id = ?2`, [guildId, warningId]);
  return rowToWarning(row);
}

/** Deactivate every active warning for a user (clearwarnings). */
export async function clearWarnings(env, guildId, userId, clearedBy = null) {
  requireSnowflake(guildId, 'guildId');
  requireSnowflake(userId, 'userId');
  const meta = await run(
    env.DB,
    `UPDATE warnings SET active = 0, cleared_at = ?1, cleared_by = ?2, updated_at = ?1
     WHERE guild_id = ?3 AND user_id = ?4 AND active = 1`,
    [nowMs(), clearedBy ? optionalSnowflake(clearedBy, 'clearedBy') : null, guildId, userId],
  );
  return meta.changes || 0;
}

/* ---------------------------------------------------------------------- notes */

/** Create a staff-only note about a user. */
export async function createNote(env, guildId, input = {}) {
  requireSnowflake(guildId, 'guildId');
  const userId = requireSnowflake(input.userId, 'userId');
  const authorId = requireSnowflake(input.authorId, 'authorId');
  const content = text(input.content, 1000);
  if (!content) throw new StorageError('Note content is required');

  const now = nowMs();
  const id = await insertReturningId(
    env.DB,
    `INSERT INTO notes (guild_id, user_id, author_id, content, case_number, active, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)`,
    [guildId, userId, authorId, content, int(input.caseNumber, { min: 0, fallback: null }), now],
  );

  const row = await first(env.DB, `SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ?1`, [id]);
  return rowToNote(row);
}

/** List notes for a user. */
export async function listNotes(env, guildId, userId) {
  requireSnowflake(guildId, 'guildId');
  requireSnowflake(userId, 'userId');
  const rows = await all(
    env.DB,
    `SELECT ${NOTE_COLUMNS} FROM notes WHERE guild_id = ?1 AND user_id = ?2 AND active = 1 ORDER BY created_at DESC LIMIT 200`,
    [guildId, userId],
  );
  return rows.map(rowToNote);
}

/** Soft-delete a note. */
export async function deleteNote(env, guildId, noteId) {
  requireSnowflake(guildId, 'guildId');
  const existing = await first(env.DB, `SELECT ${NOTE_COLUMNS} FROM notes WHERE guild_id = ?1 AND id = ?2`, [guildId, noteId]);
  if (!existing) return null;
  await run(env.DB, 'UPDATE notes SET active = 0, updated_at = ?1 WHERE guild_id = ?2 AND id = ?3', [nowMs(), guildId, noteId]);
  return rowToNote(existing);
}

/* ---------------------------------------------------------------- punishments */

/** Upsert the active punishment row for a user. */
export async function setPunishment(env, guildId, input = {}) {
  requireSnowflake(guildId, 'guildId');
  const userId = requireSnowflake(input.userId, 'userId');
  const type = oneOf(input.type, ['mute', 'ban', 'role'], 'type');
  const roleId = optionalSnowflake(input.roleId, 'roleId');
  if (type === 'role' && !roleId) throw new StorageError('roleId is required for role punishments');

  const now = nowMs();
  await run(
    env.DB,
    `INSERT INTO punishments (guild_id, user_id, type, role_id, reason, moderator_id, case_number, active, created_at, expires_at, updated_at)
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
    [guildId, userId, type, roleId, text(input.reason, 500),
      input.moderatorId ? optionalSnowflake(input.moderatorId, 'moderatorId') : null,
      int(input.caseNumber, { min: 0, fallback: null }), now,
      int(input.expiresAt, { min: 0, fallback: null })],
  );

  const row = await first(
    env.DB,
    `SELECT ${PUNISHMENT_COLUMNS} FROM punishments WHERE guild_id = ?1 AND user_id = ?2 AND type = ?3 AND IFNULL(role_id, '') = ?4`,
    [guildId, userId, type, roleId || ''],
  );
  return rowToPunishment(row);
}

/** Deactivate punishment rows. Omit type to clear every type at once. */
export async function clearPunishment(env, guildId, input = {}) {
  requireSnowflake(guildId, 'guildId');
  const userId = requireSnowflake(input.userId, 'userId');
  const params = [nowMs(), input.clearedBy ? optionalSnowflake(input.clearedBy, 'clearedBy') : null, text(input.reason, 200), guildId, userId];

  let sql = `UPDATE punishments SET active = 0, cleared_at = ?1, cleared_by = ?2, reason = COALESCE(reason, ?3), updated_at = ?1
             WHERE guild_id = ?4 AND user_id = ?5 AND active = 1`;

  if (input.type) {
    params.push(oneOf(input.type, ['mute', 'ban', 'role'], 'type'));
    sql += ` AND type = ?${params.length}`;
  }

  if (input.roleId) {
    params.push(requireSnowflake(input.roleId, 'roleId'));
    sql += ` AND role_id = ?${params.length}`;
  }

  const meta = await run(env.DB, sql, params);
  return meta.changes || 0;
}

/** Active punishments for a user. */
export async function listPunishments(env, guildId, userId, { activeOnly = true } = {}) {
  requireSnowflake(guildId, 'guildId');
  requireSnowflake(userId, 'userId');
  const rows = await all(
    env.DB,
    `SELECT ${PUNISHMENT_COLUMNS} FROM punishments
     WHERE guild_id = ?1 AND user_id = ?2 ${activeOnly ? 'AND active = 1' : ''}
     ORDER BY created_at DESC LIMIT 50`,
    [guildId, userId],
  );
  return rows.map(rowToPunishment);
}

/* -------------------------------------------------------------------- strikes */

/**
 * Record an automod strike and return the active weighted total.
 * Strikes older than the escalation window are ignored when summing.
 */
export async function addStrike(env, guildId, input = {}) {
  requireSnowflake(guildId, 'guildId');
  const userId = requireSnowflake(input.userId, 'userId');
  const rule = text(input.rule, 32) || 'unknown';
  const weight = int(input.weight, { min: 1, max: 10, fallback: 1 });
  const windowHours = int(input.windowHours, { min: 1, max: 720, fallback: 24 });
  const now = nowMs();
  const expiresAt = now + windowHours * 60 * 60 * 1000;

  await run(
    env.DB,
    `INSERT INTO automod_strikes (guild_id, user_id, rule, weight, reason, channel_id, message_id, expires_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    [guildId, userId, rule, weight, text(input.reason, 300),
      optionalSnowflake(input.channelId, 'channelId'), optionalSnowflake(input.messageId, 'messageId'), expiresAt, now],
  );

  // Opportunistic cleanup keeps the table small without a cron job.
  await run(env.DB, 'DELETE FROM automod_strikes WHERE guild_id = ?1 AND expires_at <= ?2', [guildId, now]);

  const [row] = await all(
    env.DB,
    'SELECT COALESCE(SUM(weight), 0) AS total FROM automod_strikes WHERE guild_id = ?1 AND user_id = ?2 AND expires_at > ?3',
    [guildId, userId, now],
  );

  return { strikes: row ? row.total : 0, recorded: weight, expiresAt };
}

/** Active strike total for a user. */
export async function getStrikes(env, guildId, userId, windowHours = 24) {
  requireSnowflake(guildId, 'guildId');
  requireSnowflake(userId, 'userId');
  const now = nowMs();
  const since = now - int(windowHours, { min: 1, max: 720, fallback: 24 }) * 60 * 60 * 1000;
  const [row] = await all(
    env.DB,
    'SELECT COALESCE(SUM(weight), 0) AS total FROM automod_strikes WHERE guild_id = ?1 AND user_id = ?2 AND expires_at > ?3 AND created_at >= ?4',
    [guildId, userId, now, since],
  );
  return row ? row.total : 0;
}

/** Remove all strikes for a user. */
export async function resetStrikes(env, guildId, userId) {
  requireSnowflake(guildId, 'guildId');
  requireSnowflake(userId, 'userId');
  const meta = await run(env.DB, 'DELETE FROM automod_strikes WHERE guild_id = ?1 AND user_id = ?2', [guildId, userId]);
  return meta.changes || 0;
}

/** Helper used by tests and diagnostics. */
export function debugShape(value) {
  return parseJsonColumn(toJsonColumn(value), {});
}
