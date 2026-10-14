/**
 * Guild configuration persistence and mapping.
 *
 * The guilds table stores scalars in dedicated columns and nested documents
 * (role lists, log routing, lockdown defaults) as JSON text. This module is the
 * only place that knows that mapping, so the API shape returned to the bot is
 * always the same configuration document regardless of storage layout.
 */

import { all, first, run, cacheDelete, StorageError } from '../core/db.js';
import { bool, parseJsonColumn, toJsonColumn, snowflakeArray, text, requireSnowflake, int, ValidationError } from '../core/validate.js';

/** Column list reused by every SELECT so the mapping stays in one place. */
const GUILD_COLUMNS = `
  guild_id, guild_name, prefix, prefix_enabled, slash_enabled,
  mod_role_ids, admin_role_ids, trusted_role_ids,
  muted_role_id, mute_role_enabled,
  require_reason, dm_on_punishment, delete_command_msgs,
  lockdown_config, misc_config,
  configured_at, configured_by, created_at, updated_at
`;

/** Convert a guilds row into the configuration document the bot expects. */
export function rowToConfig(row) {
  if (!row) return null;
  return {
    guildId: row.guild_id,
    guildName: row.guild_name || null,
    prefix: row.prefix || null,
    prefixEnabled: Boolean(row.prefix_enabled),
    slashEnabled: Boolean(row.slash_enabled),
    modRoleIds: parseJsonColumn(row.mod_role_ids, []),
    adminRoleIds: parseJsonColumn(row.admin_role_ids, []),
    trustedRoleIds: parseJsonColumn(row.trusted_role_ids, []),
    mutedRoleId: row.muted_role_id || null,
    muteRoleEnabled: Boolean(row.mute_role_enabled),
    requireReason: Boolean(row.require_reason),
    dmOnPunishment: Boolean(row.dm_on_punishment),
    deleteCommandMessages: Boolean(row.delete_command_msgs),
    lockdown: parseJsonColumn(row.lockdown_config, {}),
    misc: parseJsonColumn(row.misc_config, {}),
    configuredAt: row.configured_at || null,
    configuredBy: row.configured_by || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

/** Read authoritative guild state; hot-path caching is handled by the bot. */
export async function getGuildRow(env, guildId) {
  // Read authoritative D1 state. KV is eventually consistent and must not feed
  // read/modify/write ticket and nickname-lock updates.
  const row = await first(env.DB, `SELECT ${GUILD_COLUMNS} FROM guilds WHERE guild_id = ?1`, [guildId]);
  return row;
}

/** Invalidate the cached configuration row after a write. */
export async function invalidateGuildCache(env, guildId) {
  await cacheDelete(env, `guild:${guildId}`);
  await cacheDelete(env, `automod:${guildId}`);
  await cacheDelete(env, `logging:${guildId}`);
}

/** Ensure a guilds row exists, creating a minimal one when needed. */
export async function ensureGuild(env, guildId, guildName = null) {
  const existing = await first(env.DB, 'SELECT guild_id FROM guilds WHERE guild_id = ?1', [guildId]);
  if (existing) return;

  const now = Date.now();
  await run(
    env.DB,
    `INSERT INTO guilds (guild_id, guild_name, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?3)
     ON CONFLICT (guild_id) DO NOTHING`,
    [guildId, guildName, now],
  );
  await invalidateGuildCache(env, guildId);
}

/**
 * Merge a partial configuration patch into the stored row.
 * Unknown keys are ignored; every known key is validated and normalized.
 * @returns {Promise<object>} the full configuration document after the write
 */
export async function applyConfigPatch(env, guildId, patchInput) {
  requireSnowflake(guildId, 'guildId');
  const patch = patchInput && typeof patchInput === 'object' ? patchInput : {};
  await ensureGuild(env, guildId, text(patch.guildName, 120));

  const updates = [];
  const params = [];

  const push = (column, value) => {
    params.push(value);
    updates.push(`${column} = ?${params.length}`);
  };

  if (Object.prototype.hasOwnProperty.call(patch, 'guildName')) push('guild_name', text(patch.guildName, 120));
  if (Object.prototype.hasOwnProperty.call(patch, 'prefix')) {
    const prefix = patch.prefix === null ? null : text(patch.prefix, 5);
    push('prefix', prefix ? prefix.replace(/\s+/g, '') : null);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'prefixEnabled')) push('prefix_enabled', bool(patch.prefixEnabled, true) ? 1 : 0);
  if (Object.prototype.hasOwnProperty.call(patch, 'slashEnabled')) push('slash_enabled', bool(patch.slashEnabled, false) ? 1 : 0);

  if (Object.prototype.hasOwnProperty.call(patch, 'modRoleIds')) {
    push('mod_role_ids', toJsonColumn(snowflakeArray(patch.modRoleIds, 'modRoleIds')));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'adminRoleIds')) {
    push('admin_role_ids', toJsonColumn(snowflakeArray(patch.adminRoleIds, 'adminRoleIds')));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'trustedRoleIds')) {
    push('trusted_role_ids', toJsonColumn(snowflakeArray(patch.trustedRoleIds, 'trustedRoleIds')));
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'mutedRoleId')) {
    const roleId = patch.mutedRoleId === null ? null : requireSnowflake(patch.mutedRoleId, 'mutedRoleId');
    push('muted_role_id', roleId);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'muteRoleEnabled')) {
    push('mute_role_enabled', bool(patch.muteRoleEnabled, false) ? 1 : 0);
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'requireReason')) push('require_reason', bool(patch.requireReason, true) ? 1 : 0);
  if (Object.prototype.hasOwnProperty.call(patch, 'dmOnPunishment')) push('dm_on_punishment', bool(patch.dmOnPunishment, true) ? 1 : 0);
  if (Object.prototype.hasOwnProperty.call(patch, 'deleteCommandMessages')) {
    push('delete_command_msgs', bool(patch.deleteCommandMessages, false) ? 1 : 0);
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'lockdown')) push('lockdown_config', toJsonColumn(normalizeLockdown(patch.lockdown)));
  if (Object.prototype.hasOwnProperty.call(patch, 'misc')) push('misc_config', toJsonColumn(boundedMisc(patch.misc)));

  if (Object.prototype.hasOwnProperty.call(patch, 'configuredAt')) {
    push('configured_at', int(patch.configuredAt, { min: 0, fallback: null }) ?? Date.now());
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'configuredBy')) {
    push('configured_by', patch.configuredBy === null ? null : requireSnowflake(patch.configuredBy, 'configuredBy'));
  }

  const now = Date.now();
  params.push(now);
  updates.push(`updated_at = ?${params.length}`);

  const sql = `UPDATE guilds SET ${updates.join(', ')} WHERE guild_id = ?${params.length + 1}`;
  params.push(guildId);
  await run(env.DB, sql, params);

  await invalidateGuildCache(env, guildId);
  const row = await first(env.DB, `SELECT ${GUILD_COLUMNS} FROM guilds WHERE guild_id = ?1`, [guildId]);
  return rowToConfig(row);
}

/**
 * Bound the extensible per-guild state. The document must stay small: it is
 * read on every configuration load.
 */
function boundedMisc(input) {
  const source = parseJsonColumn(input, {});
  const serialized = JSON.stringify(source);
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new ValidationError('misc must be an object');
  }
  if (new TextEncoder().encode(serialized).length > 16384) {
    throw new ValidationError('misc exceeds the 16 KiB storage limit; no settings were changed');
  }
  return source;
}

/** Normalize lockdown defaults. */
function normalizeLockdown(input) {
  const source = parseJsonColumn(input, {});
  return {
    channelIds: snowflakeArray(source.channelIds, 'lockdown.channelIds'),
    roleIds: snowflakeArray(source.roleIds, 'lockdown.roleIds'),
    autoUnlockMinutes: int(source.autoUnlockMinutes, { min: 0, max: 10080, fallback: 0 }),
  };
}

/** Delete every trace of a guild (config, cases, warnings, notes, tasks). */
export async function purgeGuild(env, guildId) {
  requireSnowflake(guildId, 'guildId');
  const tables = ['cases', 'warnings', 'notes', 'punishments', 'automod_strikes', 'scheduled_tasks', 'automod_settings', 'logging_settings', 'guild_counters'];
  for (const table of tables) {
    await run(env.DB, `DELETE FROM ${table} WHERE guild_id = ?1`, [guildId]);
  }
  await run(env.DB, 'DELETE FROM guilds WHERE guild_id = ?1', [guildId]);
  await invalidateGuildCache(env, guildId);
}

/** Aggregate statistics for the config and stats commands. */
export async function guildStats(env, guildId) {
  requireSnowflake(guildId, 'guildId');
  const [cases] = await all(env.DB, 'SELECT COUNT(*) AS total FROM cases WHERE guild_id = ?1', [guildId]);
  const [warnings] = await all(env.DB, 'SELECT COUNT(*) AS total FROM warnings WHERE guild_id = ?1 AND active = 1', [guildId]);
  const [notes] = await all(env.DB, 'SELECT COUNT(*) AS total FROM notes WHERE guild_id = ?1 AND active = 1', [guildId]);
  const [pending] = await all(env.DB, "SELECT COUNT(*) AS total FROM scheduled_tasks WHERE guild_id = ?1 AND status = 'pending'", [guildId]);
  return {
    cases: cases ? cases.total : 0,
    activeWarnings: warnings ? warnings.total : 0,
    notes: notes ? notes.total : 0,
    pendingTasks: pending ? pending.total : 0,
  };
}

/** Guard used by routes that need a configured guild. */
export async function requireGuild(env, guildId) {
  const row = await getGuildRow(env, guildId);
  if (!row) throw new StorageError('Guild is not configured');
  return row;
}
