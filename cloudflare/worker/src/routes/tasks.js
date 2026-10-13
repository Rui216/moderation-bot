/**
 * Scheduled task routes used by the expiry worker in the bot.
 */

import { ok, errors } from '../core/http.js';
import { createTask, listTasks, claimDueTasks, completeTask, cancelTasks } from '../data/tasks.js';
import { int } from '../core/validate.js';

/** POST /v1/guilds/:guildId/tasks */
export async function create(ctx) {
  const task = await createTask(ctx.env, ctx.params.guildId, ctx.body || {});
  return ok({ task }, 201);
}

/** GET /v1/guilds/:guildId/tasks?status=&targetId=&type= */
export async function list(ctx) {
  const url = ctx.url;
  const tasks = await listTasks(ctx.env, ctx.params.guildId, {
    status: url.searchParams.get('status') || undefined,
    targetId: url.searchParams.get('targetId') || undefined,
    type: url.searchParams.get('type') || undefined,
  });
  return ok({ tasks });
}

/** POST /v1/tasks/claim - claims due tasks across every guild. */
export async function claim(ctx) {
  const limit = int(ctx.body && ctx.body.limit, { min: 1, max: 100, fallback: 25 });
  const tasks = await claimDueTasks(ctx.env, limit);
  return ok({ tasks, count: tasks.length });
}

/** POST /v1/guilds/:guildId/tasks/:taskId/complete */
export async function complete(ctx) {
  const taskId = int(ctx.params.taskId, { min: 1 });
  const status = (ctx.body && ctx.body.status) || 'done';
  const lastError = (ctx.body && ctx.body.lastError) || null;
  const result = await completeTask(ctx.env, ctx.params.guildId, taskId, status, lastError);
  if (!result.updated) return errors.notFound();
  return ok(result);
}

/** POST /v1/guilds/:guildId/tasks/cancel */
export async function cancel(ctx) {
  const result = await cancelTasks(ctx.env, ctx.params.guildId, ctx.body || {});
  return ok(result);
}
