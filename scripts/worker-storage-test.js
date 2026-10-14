'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { sqliteD1 } = require('./helpers/sqliteD1');
const GUILD = '100000000000000000', USER = '100000000000000001';
const ROLE1 = '100000000000000002', ROLE2 = '100000000000000003';

test('Worker persistence with real SQLite', async (t) => {
  const { binding: DB, database } = await sqliteD1();
  const env = { DB, WORKER_AUTH_TOKEN: 'test-token-value-that-is-long-enough' };
  const guilds = await import('../cloudflare/worker/src/data/guilds.js');
  const moderation = await import('../cloudflare/worker/src/data/moderation.js');
  const cases = await import('../cloudflare/worker/src/data/cases.js');
  const tasks = await import('../cloudflare/worker/src/data/tasks.js');
  const worker = (await import('../cloudflare/worker/src/index.js')).default;
  await guilds.applyConfigPatch(env, GUILD, { guildName: 'Regression guild', misc: { keep: true } });

  await t.test('oversized or invalid misc is rejected, never replaced by an empty object', async () => {
    await assert.rejects(guilds.applyConfigPatch(env, GUILD, { misc: { large: '💬'.repeat(5000) } }), /16 KiB/);
    await assert.rejects(guilds.applyConfigPatch(env, GUILD, { misc: [] }), /must be an object/);
    assert.deepEqual(guilds.rowToConfig(await guilds.getGuildRow(env, GUILD)).misc, { keep: true });
    const response = await worker.fetch(new Request(`https://gateway.example/v1/guilds/${GUILD}/config`, {
      method: 'PUT', headers: { Authorization: `Bearer ${env.WORKER_AUTH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch: { misc: { large: 'a'.repeat(17000) } } }),
    }), env);
    assert.equal(response.status, 422);
  });
  await t.test('authoritative guild reads ignore stale KV values', async () => {
    const config = await guilds.getGuildRow({ ...env, KV: { get: async () => JSON.stringify({ misc_config: '{}' }) } }, GUILD);
    assert.deepEqual(guilds.rowToConfig(config).misc, { keep: true });
  });
  await t.test('system cases can atomically create a warning, punishment, and scheduled task', async () => {
    const result = await cases.createCase(env, GUILD, { action: 'tempmute', targetId: USER, moderatorId: 'system',
      reason: 'Automod test', warning: {}, punishment: { type: 'mute', expiresAt: Date.now() + 1000 },
      task: { type: 'unmute', targetId: USER, runAt: Date.now() + 1000, payload: {} } });
    assert.equal(result.case.moderatorId, 'system');
    assert.equal(result.case.warningId, result.warningId);
    assert(result.warningId > 0);
    const warnings = database.exec('SELECT * FROM warnings')[0].values;
    assert.equal(warnings.length, 1);
    assert.equal((await moderation.listPunishments(env, GUILD, USER))[0].caseNumber, result.caseNumber);
    assert.equal((await tasks.listTasks(env, GUILD))[0].caseNumber, result.caseNumber);
  });
  await t.test('failed case batch leaves no orphan warnings', async () => {
    const before = database.exec('SELECT COUNT(*) FROM warnings')[0].values[0][0];
    database.run("CREATE TRIGGER fail_case BEFORE INSERT ON cases BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    await assert.rejects(cases.createCase(env, GUILD, { action: 'warn', targetId: USER, moderatorId: 'system', warning: {} }));
    database.run('DROP TRIGGER fail_case');
    assert.equal(database.exec('SELECT COUNT(*) FROM warnings')[0].values[0][0], before);
    await assert.rejects(cases.createCase(env, GUILD, { action: 'warn', targetId: USER, warning: {},
      task: { type: 'invalid-task', runAt: Date.now() } }));
    assert.equal(database.exec('SELECT COUNT(*) FROM warnings')[0].values[0][0], before);
  });
  await t.test('role clear and task cancellation affect only the selected role', async () => {
    for (const roleId of [ROLE1, ROLE2]) {
      await moderation.setPunishment(env, GUILD, { type: 'role', userId: USER, roleId });
      await tasks.createTask(env, GUILD, { type: 'remove_role', targetId: USER, runAt: Date.now() + 60000, payload: { roleId } });
    }
    await moderation.clearPunishment(env, GUILD, { type: 'role', userId: USER, roleId: ROLE1 });
    const active = await moderation.listPunishments(env, GUILD, USER);
    assert.deepEqual(active.filter((p) => p.type === 'role').map((p) => p.roleId), [ROLE2]);
    await tasks.cancelTasks(env, GUILD, { type: 'remove_role', targetId: USER, roleId: ROLE1 });
    const roleTasks = await tasks.listTasks(env, GUILD, { type: 'remove_role' });
    assert.equal(roleTasks.find((task) => task.payload.roleId === ROLE1).status, 'cancelled');
    assert.equal(roleTasks.find((task) => task.payload.roleId === ROLE2).status, 'pending');
  });
  await t.test('task claims are exclusive, retries delayed, and cancellation is not overwritten', async () => {
    database.run('DELETE FROM scheduled_tasks');
    const created = await tasks.createTask(env, GUILD, { type: 'unlock', targetId: ROLE1, runAt: Date.now() - 1000 });
    const claimed = await tasks.claimDueTasks(env);
    assert.equal(claimed.length, 1);
    assert.equal((await tasks.claimDueTasks(env)).length, 0);
    await tasks.completeTask(env, GUILD, created.id, 'pending', 'transient failure');
    const delayed = (await tasks.listTasks(env, GUILD))[0];
    assert.equal(delayed.status, 'pending');
    assert(delayed.runAt > Date.now());
    assert.equal((await tasks.claimDueTasks(env)).length, 0);
    database.run("UPDATE scheduled_tasks SET run_at = 0");
    await tasks.claimDueTasks(env);
    await tasks.cancelTasks(env, GUILD, { taskId: created.id });
    assert.equal((await tasks.completeTask(env, GUILD, created.id, 'done')).updated, 0);
    assert.equal((await tasks.listTasks(env, GUILD))[0].status, 'cancelled');
  });
  await t.test('active strike totals exclude expired strikes', async () => {
    await moderation.addStrike(env, GUILD, { userId: USER, rule: 'words', weight: 3 });
    assert.equal(await moderation.getStrikes(env, GUILD, USER), 3);
    database.run('UPDATE automod_strikes SET expires_at = ?', [Date.now() - 1]);
    assert.equal(await moderation.getStrikes(env, GUILD, USER), 0);
  });
  database.close();
});
