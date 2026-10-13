/**
 * Guild routes: configuration read/write, statistics, and purge.
 */

import { ok, errors } from '../core/http.js';
import { getGuildRow, applyConfigPatch, purgeGuild, guildStats, rowToConfig } from '../data/guilds.js';

/** GET /v1/guilds/:guildId/config */
export async function getConfig(ctx) {
  const row = await getGuildRow(ctx.env, ctx.params.guildId);
  if (!row) return errors.notFound();
  return ok({ config: rowToConfig(row) });
}

/** PUT /v1/guilds/:guildId/config - merges the supplied patch. */
export async function putConfig(ctx) {
  const patch = ctx.body && ctx.body.patch ? ctx.body.patch : {};
  const config = await applyConfigPatch(ctx.env, ctx.params.guildId, patch);
  return ok({ config });
}

/** GET /v1/guilds/:guildId/stats */
export async function stats(ctx) {
  const result = await guildStats(ctx.env, ctx.params.guildId);
  return ok({ stats: result });
}

/** DELETE /v1/guilds/:guildId - removes every row belonging to the guild. */
export async function remove(ctx) {
  await purgeGuild(ctx.env, ctx.params.guildId);
  return ok({ purged: true });
}
