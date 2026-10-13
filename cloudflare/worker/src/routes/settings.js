/**
 * Settings routes: automod configuration and logging configuration.
 */

import { ok } from '../core/http.js';
import { getAutomodSettings, updateAutomodSettings, getLoggingSettings, updateLoggingSettings } from '../data/settings.js';

/** GET /v1/guilds/:guildId/automod */
export async function getAutomod(ctx) {
  const settings = await getAutomodSettings(ctx.env, ctx.params.guildId);
  return ok({ automod: settings });
}

/** PUT /v1/guilds/:guildId/automod */
export async function putAutomod(ctx) {
  const patch = ctx.body && ctx.body.patch ? ctx.body.patch : (ctx.body || {});
  const settings = await updateAutomodSettings(ctx.env, ctx.params.guildId, patch);
  return ok({ automod: settings });
}

/** GET /v1/guilds/:guildId/logging */
export async function getLogging(ctx) {
  const settings = await getLoggingSettings(ctx.env, ctx.params.guildId);
  return ok({ logging: settings });
}

/** PUT /v1/guilds/:guildId/logging */
export async function putLogging(ctx) {
  const patch = ctx.body && ctx.body.patch ? ctx.body.patch : (ctx.body || {});
  const settings = await updateLoggingSettings(ctx.env, ctx.params.guildId, patch);
  return ok({ logging: settings });
}
