/**
 * Case routes: create, read, list, update, export.
 */

import { ok, errors } from '../core/http.js';
import { createCase, getCase, listCases, updateCase, exportCases } from '../data/cases.js';
import { int } from '../core/validate.js';

/** POST /v1/guilds/:guildId/cases */
export async function create(ctx) {
  const result = await createCase(ctx.env, ctx.params.guildId, ctx.body || {});
  return ok({ case: result.case, warningId: result.warningId, caseNumber: result.caseNumber }, 201);
}

/** GET /v1/guilds/:guildId/cases */
export async function list(ctx) {
  const url = ctx.url;
  const result = await listCases(ctx.env, ctx.params.guildId, {
    userId: url.searchParams.get('userId') || undefined,
    moderatorId: url.searchParams.get('moderatorId') || undefined,
    action: url.searchParams.get('action') || undefined,
    activeOnly: url.searchParams.get('activeOnly') === 'true',
    page: int(url.searchParams.get('page'), { min: 1, max: 100000, fallback: 1 }),
    limit: int(url.searchParams.get('limit'), { min: 1, max: 500, fallback: 25 }),
  });
  return ok(result);
}

/** GET /v1/guilds/:guildId/cases/export */
export async function exportAll(ctx) {
  const limit = int(ctx.url.searchParams.get('limit'), { min: 1, max: 5000, fallback: 1000 });
  const cases = await exportCases(ctx.env, ctx.params.guildId, limit);
  return ok({ cases, count: cases.length });
}

/** GET /v1/guilds/:guildId/cases/:caseNumber */
export async function getOne(ctx) {
  const caseNumber = int(ctx.params.caseNumber, { min: 1 });
  const record = await getCase(ctx.env, ctx.params.guildId, caseNumber);
  if (!record) return errors.notFound();
  return ok({ case: record });
}

/** PATCH /v1/guilds/:guildId/cases/:caseNumber */
export async function patch(ctx) {
  const caseNumber = int(ctx.params.caseNumber, { min: 1 });
  const record = await updateCase(ctx.env, ctx.params.guildId, caseNumber, ctx.body || {});
  if (!record) return errors.notFound();
  return ok({ case: record });
}
