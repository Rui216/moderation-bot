/**
 * Moderation support routes: warnings, notes, punishment state, and strikes.
 */

import { ok, errors } from '../core/http.js';
import {
  listWarnings, countWarnings, deleteWarning, updateWarning, clearWarnings,
  createNote, listNotes, deleteNote,
  setPunishment, clearPunishment, listPunishments,
  addStrike, getStrikes, resetStrikes,
} from '../data/moderation.js';
import { int, requireSnowflake } from '../core/validate.js';

/* ------------------------------------------------------------------ warnings */

/** GET /v1/guilds/:guildId/warnings?userId=&activeOnly= */
export async function warningsList(ctx) {
  const userId = requireSnowflake(ctx.url.searchParams.get('userId'), 'userId');
  const warnings = await listWarnings(ctx.env, ctx.params.guildId, userId, {
    activeOnly: ctx.url.searchParams.get('activeOnly') === 'true',
  });
  return ok({ warnings });
}

/** GET /v1/guilds/:guildId/warnings/count?userId=&activeOnly= */
export async function warningsCount(ctx) {
  const userId = requireSnowflake(ctx.url.searchParams.get('userId'), 'userId');
  const activeOnly = ctx.url.searchParams.get('activeOnly') !== 'false';
  const counts = await countWarnings(ctx.env, ctx.params.guildId, userId, { activeOnly });
  return ok(counts);
}

/** DELETE /v1/guilds/:guildId/warnings/:warningId */
export async function warningsDelete(ctx) {
  const warningId = int(ctx.params.warningId, { min: 1 });
  const clearedBy = (ctx.body && ctx.body.clearedBy) || null;
  const warning = await deleteWarning(ctx.env, ctx.params.guildId, warningId, clearedBy);
  if (!warning) return errors.notFound();
  return ok({ warning });
}

/** PATCH /v1/guilds/:guildId/warnings/:warningId */
export async function warningsPatch(ctx) {
  const warningId = int(ctx.params.warningId, { min: 1 });
  const warning = await updateWarning(ctx.env, ctx.params.guildId, warningId, ctx.body || {});
  if (!warning) return errors.notFound();
  return ok({ warning });
}

/** POST /v1/guilds/:guildId/warnings/clear */
export async function warningsClear(ctx) {
  const userId = requireSnowflake(ctx.body && ctx.body.userId, 'userId');
  const cleared = await clearWarnings(ctx.env, ctx.params.guildId, userId, (ctx.body && ctx.body.clearedBy) || null);
  return ok({ cleared });
}

/* --------------------------------------------------------------------- notes */

/** GET /v1/guilds/:guildId/notes?userId= */
export async function notesList(ctx) {
  const userId = requireSnowflake(ctx.url.searchParams.get('userId'), 'userId');
  const notes = await listNotes(ctx.env, ctx.params.guildId, userId);
  return ok({ notes });
}

/** POST /v1/guilds/:guildId/notes */
export async function notesCreate(ctx) {
  const note = await createNote(ctx.env, ctx.params.guildId, ctx.body || {});
  return ok({ note }, 201);
}

/** DELETE /v1/guilds/:guildId/notes/:noteId */
export async function notesDelete(ctx) {
  const noteId = int(ctx.params.noteId, { min: 1 });
  const note = await deleteNote(ctx.env, ctx.params.guildId, noteId);
  if (!note) return errors.notFound();
  return ok({ note });
}

/* -------------------------------------------------------------- punishments */

/** GET /v1/guilds/:guildId/punishments?userId=&activeOnly= */
export async function punishmentsList(ctx) {
  const userId = requireSnowflake(ctx.url.searchParams.get('userId'), 'userId');
  const activeOnly = ctx.url.searchParams.get('activeOnly') !== 'false';
  const punishments = await listPunishments(ctx.env, ctx.params.guildId, userId, { activeOnly });
  return ok({ punishments });
}

/** POST /v1/guilds/:guildId/punishments */
export async function punishmentsSet(ctx) {
  const punishment = await setPunishment(ctx.env, ctx.params.guildId, ctx.body || {});
  return ok({ punishment });
}

/** POST /v1/guilds/:guildId/punishments/clear */
export async function punishmentsClear(ctx) {
  const cleared = await clearPunishment(ctx.env, ctx.params.guildId, ctx.body || {});
  return ok({ cleared });
}

/* ------------------------------------------------------------------- strikes */

/** GET /v1/guilds/:guildId/strikes?userId=&windowHours= */
export async function strikesGet(ctx) {
  const userId = requireSnowflake(ctx.url.searchParams.get('userId'), 'userId');
  const windowHours = int(ctx.url.searchParams.get('windowHours'), { min: 1, max: 720, fallback: 24 });
  const strikes = await getStrikes(ctx.env, ctx.params.guildId, userId, windowHours);
  return ok({ strikes });
}

/** POST /v1/guilds/:guildId/strikes */
export async function strikesAdd(ctx) {
  const result = await addStrike(ctx.env, ctx.params.guildId, ctx.body || {});
  return ok(result, 201);
}

/** POST /v1/guilds/:guildId/strikes/reset */
export async function strikesReset(ctx) {
  const userId = requireSnowflake(ctx.body && ctx.body.userId, 'userId');
  const removed = await resetStrikes(ctx.env, ctx.params.guildId, userId);
  return ok({ removed });
}
