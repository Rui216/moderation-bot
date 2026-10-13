/**
 * Bot-level routes: health, readiness, and heartbeat.
 *
 * /health is intentionally public and reveals nothing but liveness, so an
 * uptime monitor can probe the gateway without holding the shared secret.
 * /v1/health additionally verifies database connectivity and requires auth.
 */

import { ok, json } from '../core/http.js';
import { first, run } from '../core/db.js';
import { taskSummary } from '../data/tasks.js';
import { text, int, nowMs } from '../core/validate.js';

/** Public liveness probe. */
export function health() {
  return json({
    ok: true,
    service: 'moderation-gateway',
    version: '1.0.0',
    time: new Date().toISOString(),
  });
}

/** Authenticated readiness probe: confirms D1 is reachable. */
export async function readiness(ctx) {
  const row = await first(ctx.env.DB, 'SELECT 1 AS value');
  const tasks = await taskSummary(ctx.env).catch(() => null);
  return ok({
    database: row && row.value === 1 ? 'reachable' : 'unreachable',
    cache: ctx.env.KV ? 'enabled' : 'disabled',
    tasks,
    time: new Date().toISOString(),
  });
}

/**
 * Record a bot heartbeat. Keeps a single row so uptime and version can be
 * inspected without reading process logs.
 */
export async function heartbeat(ctx) {
  const payload = ctx.body || {};
  const now = nowMs();

  await run(
    ctx.env.DB,
    `INSERT INTO bot_status (id, version, started_at, last_heartbeat, guild_count, latency_ms, notes)
     VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (id) DO UPDATE SET
       version = excluded.version,
       started_at = COALESCE(bot_status.started_at, excluded.started_at),
       last_heartbeat = excluded.last_heartbeat,
       guild_count = excluded.guild_count,
       latency_ms = excluded.latency_ms,
       notes = excluded.notes`,
    [
      text(payload.version, 32),
      int(payload.startedAt, { min: 0, fallback: now }),
      now,
      int(payload.guildCount, { min: 0, max: 1000000, fallback: 0 }),
      int(payload.latencyMs, { min: 0, max: 600000, fallback: null }),
      text(payload.notes, 200),
    ],
  );

  return ok({ recorded: true, time: new Date().toISOString() });
}

/** Current heartbeat row, used by the bot's status command. */
export async function status(ctx) {
  const row = await first(ctx.env.DB, 'SELECT version, started_at, last_heartbeat, guild_count, latency_ms FROM bot_status WHERE id = 1');
  return ok({
    status: row
      ? {
        version: row.version,
        startedAt: row.started_at,
        lastHeartbeat: row.last_heartbeat,
        guildCount: row.guild_count,
        latencyMs: row.latency_ms,
      }
      : null,
  });
}
