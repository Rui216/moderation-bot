'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Collection, PermissionFlagsBits: P, PermissionsBitField } = require('discord.js');
const { fixture, IDS } = require('./helpers/ticketFixture');
const f = fixture();
const extraRepos = {};
require('../src/db').repo = (name) => name === 'guilds' ? f.repo : extraRepos[name];
const { CommandContext } = require('../src/core/context');
const dispatcher = require('../src/core/dispatcher');
const registry = require('../src/core/registry');
const parser = require('../src/utils/parser');
const args = require('../src/utils/args');
const { deepMerge, isPlainObject } = require('../src/utils/objects');
const channels = require('../src/services/channelService');
const moderation = require('../src/services/moderationService');
const punishment = require('../src/services/punishmentService');
const hierarchy = require('../src/services/hierarchyService');
const scheduler = require('../src/services/taskService');
const automod = require('../src/automod/automodService');
const logging = require('../src/services/loggingService');
const wizard = require('../src/core/setupWizard');
const { HttpClient } = require('../src/db/httpClient');
const { defaultLoggingConfig } = require('../src/config/defaults');
const { LOG_EVENTS } = require('../src/config/constants');
const slowmode = require('../src/commands/channels/slowmode');

async function patch(object, key, value, work) {
  const original = object[key];
  object[key] = value;
  try { return await work(); } finally { object[key] = original; }
}

test('Service regressions', async (t) => {
  await t.test('deferred command replies edit the original response, subsequent messages follow up', async () => {
    const i = f.interaction('');
    await i.deferReply();
    const ctx = new CommandContext({ interaction: i });
    await ctx.replyEmbed({ title: 'First' });
    assert.equal(i.response.embeds[0].title, 'First');
    assert.equal(i.followups.length, 0);
    await ctx.replyEmbed({ title: 'Second' });
    assert.equal(i.followups[0].embeds[0].title, 'Second');
    const other = f.interaction('');
    await other.deferReply();
    await new CommandContext({ interaction: other }).replyEmbeds([{ title: 'Multiple' }]);
    assert.equal(other.followups.length, 0);
    assert.equal(other.response.embeds[0].title, 'Multiple');
  });
  await t.test('slash acknowledgement happens before configuration I/O', async () => {
    registry.loadDirectory(require('node:path').join(__dirname, '../src/commands'));
    const i = f.interaction('', IDS.user);
    i.isChatInputCommand = () => true;
    i.commandName = 'ping';
    await patch(f.repo, 'getConfig', async () => { assert.equal(i.deferred, true); return { slashEnabled: false }; }, async () => {
      await dispatcher.handleInteraction({ client: f.client, appConfig: { discord: { ownerIds: [] } } }, i);
    });
    assert.equal(i.response.embeds[0].title, 'Slash Commands Disabled');
  });
  await t.test('invalid explicit channel does not turn into a server-wide operation', async () => {
    await patch(parser, 'resolveChannel', async () => null, async () => {
      await assert.rejects(args.resolveChannelArg({ guild: f.guild, args: [`<#${IDS.other}>`] }), /No channels were changed/);
      assert.equal(await args.resolveChannelArg({ guild: f.guild, args: ['Reason'] }), null);
    });
  });
  await t.test('compound duration arguments are recognized without swallowing the reason', () => {
    assert.deepEqual(args.takeDuration(['1d2h', '30m', 'reason']), { durationMs: 95400000, rest: ['reason'] });
    assert.equal(args.takeDuration(['0s', 'reason']).invalid, 'non-positive');
    assert.equal(args.takeDuration(['ordinary', 'reason']).durationMs, null);
  });
  await t.test('slowmode slash target and numeric reason text are preserved', async () => {
    let captured;
    await patch(channels, 'slowmode', async (...values) => { captured = values; return { embed: { title: 'ok' } }; }, async () => {
      await patch(parser, 'resolveChannel', async () => f.log, async () => {
        await slowmode.execute({ isSlash: true, guild: f.guild, channel: f.panel, config: { requireReason: false },
          args: ['30', `<#${IDS.log}>`, 'wait 10 seconds'], replyEmbed: async () => {} });
        assert.equal(captured[1].id, IDS.log);
        assert.equal(captured[2], 30);
        assert.equal(captured[3], 'wait 10 seconds');
        await assert.rejects(slowmode.execute({ isSlash: true, args: ['30oops'], channel: f.panel }), /whole number/);
      });
    });
  });
  await t.test('prototype keys are ignored and dates are not treated as plain objects', () => {
    const merged = deepMerge({}, JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"bad":true}},"safe":1}'));
    assert.equal(merged.safe, 1);
    assert.equal(merged.polluted, undefined);
    assert.equal({}.polluted, undefined);
    assert.equal(isPlainObject(new Date()), false);
    assert.equal(isPlainObject(Object.create(null)), true);
  });
  await t.test('weighted escalation chooses the highest newly crossed threshold', () => {
    const steps = [{ strikes: 3, action: 'warn' }, { strikes: 5, action: 'mute' }, { strikes: 8, action: 'ban' }];
    assert.equal(automod.selectEscalationStep(steps, 6, 4).action, 'mute');
    assert.equal(automod.selectEscalationStep(steps, 7, 1), null);
    assert.equal(automod.selectEscalationStep(steps, 8, 1).action, 'ban');
  });
  await t.test('editing a previously clean message is evaluated, duplicate revisions are ignored', async () => {
    let strikes = 0, deleted = 0;
    extraRepos.punishments = { addStrike: async () => ({ strikes: ++strikes, recorded: 1 }) };
    const message = { id: 'edit-test', content: 'hello', guild: f.guild, member: f.members.get(IDS.user), channel: f.panel,
      author: { id: IDS.user, tag: 'Alice', displayAvatarURL: () => null, send: async () => {} },
      deletable: true, delete: async () => { deleted++; } };
    const context = { config: {}, automod: { enabled: true, exemptions: { ignoreStaff: false },
      rules: { words: { enabled: true, punishment: 'delete', words: ['blocked'], strikeWeight: 1 } }, escalation: { enabled: false } } };
    await patch(logging, 'emit', async () => {}, async () => {
      assert.equal((await automod.handleMessage(message, context)).handled, false);
      message.content = 'blocked';
      assert.equal((await automod.handleMessage(message, context)).handled, true);
      assert.equal((await automod.handleMessage(message, context)).reason, 'already-processed');
    });
    assert.equal(strikes, 1);
    assert.equal(deleted, 1);
  });
  await t.test('lock snapshots restore explicit allows and preserve pre-existing denials on retries', async () => {
    const c = f.channel('300000000000000020');
    const overwrite = (value) => ({ allow: new PermissionsBitField(value === true ? [P.SendMessages] : []),
      deny: new PermissionsBitField(value === false ? [P.SendMessages] : []) });
    const overrides = new Collection([[IDS.role, overwrite(true)], [IDS.guild, overwrite(false)]]);
    let fail = false;
    c.permissionOverwrites = { cache: overrides, edit: async (id, value) => {
      if (fail) throw new Error('permissions missing');
      overrides.set(id, overwrite(value.SendMessages));
    } };
    await channels.lockChannel(f.guild, c, { roleIds: [IDS.role, IDS.guild] });
    assert.equal(f.state.misc.channelLocks[c.id][IDS.role], true);
    assert.equal(overrides.get(IDS.role).deny.has(P.SendMessages), true);
    await channels.unlockChannel(f.guild, c, { roleIds: [IDS.role, IDS.guild] });
    assert.equal(overrides.get(IDS.role).allow.has(P.SendMessages), true);
    assert.equal(overrides.get(IDS.guild).deny.has(P.SendMessages), true);
    await channels.unlockChannel(f.guild, c, { roleIds: [IDS.role, IDS.guild] });
    assert.equal(overrides.get(IDS.guild).deny.has(P.SendMessages), true);
    fail = true;
    await assert.rejects(channels.lockChannel(f.guild, c, { roleIds: [IDS.role] }), /permissions missing/);
    assert.equal(f.state.misc.channelLocks[c.id][IDS.role], true);
    fail = false;
    await patch(moderation, 'applyAction', async (options) => { assert.equal(options.action, 'server_unlock'); assert.equal(options.channelId, null); return { embed: {} }; }, async () => {
      await channels.unlock({ guild: f.guild, config: f.state }, null, { system: true, channelIds: [c.id], roleIds: [IDS.role] });
    });
  });
  await t.test('native mute always schedules expiry, including the default-duration command', async () => {
    let options;
    await patch(hierarchy, 'assertBotPermissions', () => {}, async () => {
      await patch(moderation, 'applyAction', async (input) => { options = input; return {}; }, async () => {
        await punishment.mute({ guild: f.guild, config: {}, limits: {} }, f.members.get(IDS.user), { temporary: false, durationMs: 60000, reason: 'test' });
      });
    });
    assert.equal(options.task.type, 'unmute');
    assert(options.task.runAt > Date.now());
  });
  await t.test('automated unban does not cancel its own running expiry task', async () => {
    let cancelled = false;
    extraRepos.tasks = { cancel: async () => { cancelled = true; } };
    extraRepos.punishments = { clear: async () => {} };
    f.guild.bans = { fetch: async () => ({ user: { id: IDS.user } }) };
    await patch(hierarchy, 'assertBotPermissions', () => {}, async () => {
      await patch(moderation, 'applyAction', async () => ({}), async () => {
        await punishment.unban({ guild: f.guild, config: {} }, { id: IDS.user }, { system: true });
      });
    });
    assert.equal(cancelled, false);
  });
  await t.test('scheduler removes legacy mute role after native timeout has expired', async () => {
    let unmutes = 0;
    f.state.muteRoleEnabled = true;
    f.state.mutedRoleId = IDS.role;
    const member = f.members.get(IDS.user);
    member.roles.cache.set(IDS.role, {});
    member.isCommunicationDisabled = () => false;
    const client = { guilds: { cache: new Collection([[IDS.guild, f.guild]]) }, services: { punishmentService: {
      unmute: async (_ctx, _member, options) => { assert.equal(options.muteRoleId, IDS.role); unmutes++; },
    } } };
    extraRepos.punishments = { clear: async () => { throw new Error('must unmute instead'); } };
    await scheduler.executeTask({ guildId: IDS.guild, type: 'unmute', targetId: IDS.user }, { client });
    assert.equal(unmutes, 1);
    member.roles.cache.delete(IDS.role);
  });
  await t.test('scheduler does not mistake network failure for a departed member', async () => {
    const client = { guilds: { cache: new Collection([[IDS.guild, f.guild]]) } };
    let cleared = false;
    extraRepos.punishments = { clear: async () => { cleared = true; } };
    await patch(f.guild.members, 'fetch', async () => { throw new Error('network failed'); }, async () => {
      await assert.rejects(scheduler.executeTask({ guildId: IDS.guild, type: 'unmute', targetId: IDS.user }, { client }), /network/);
    });
    assert.equal(cleared, false);
  });
  await t.test('old expiry cannot undo a newer punishment and transient task failures are retried', async () => {
    const client = { guilds: { cache: new Collection([[IDS.guild, f.guild]]) } };
    extraRepos.punishments = { list: async () => [{ type: 'mute', caseNumber: 2 }] };
    const result = await scheduler.executeTask({ guildId: IDS.guild, type: 'unmute', targetId: IDS.user, caseNumber: 1 }, { client });
    assert.equal(result.status, 'cancelled');
    let status;
    extraRepos.tasks = { claimDue: async () => [{ id: 1, guildId: IDS.guild, type: 'unmute', targetId: IDS.user, attempts: 1, maxAttempts: 3 }],
      complete: async (_guild, _id, value) => { status = value; } };
    await patch(f.guild.members, 'fetch', async () => { throw new Error('transient'); }, async () => { await scheduler.runOnce({ client }); });
    assert.equal(status, 'pending');
  });
  await t.test('main wizard binds input to its channel, preserves unseen log events, and supports all roles', async () => {
    const logConfig = defaultLoggingConfig();
    for (const value of Object.values(logConfig.events)) value.enabled = true;
    logConfig.channels.modLog = IDS.log;
    await patch(f.repo, 'getLogging', async () => logConfig, async () => {
      const i = f.interaction('', IDS.admin);
      const client = { appConfig: { discord: { defaultPrefix: '!', ownerIds: [] } } };
      await i.deferReply();
      const session = await wizard.start({ client, guild: f.guild, member: f.members.get(IDS.admin), channel: f.panel, interaction: i, config: f.state });
      assert.equal(session.data.logChannels.modLog, IDS.log);
      session.awaitingText = 'prefix';
      assert.equal(await wizard.handleMessage({ guild: f.guild, author: { id: IDS.admin }, channel: f.log, content: '?' }), false);
      session.stepIndex = wizard.STEPS.indexOf('log_events');
      await wizard.render(session);
      const select = f.interaction('setup:events:select', IDS.admin);
      select.values = [];
      select.message = { id: session.messageId };
      select.isAnySelectMenu = () => true;
      await wizard.handleComponent(client, select);
      assert.deepEqual(session.data.enabledEvents, Object.keys(LOG_EVENTS).slice(25));
      session.stepIndex = wizard.STEPS.indexOf('admin_roles');
      await wizard.render(session);
      assert.equal(i.response.components[0].toJSON().components[0].type, 6); // Native role select
      wizard.destroy(session.key);
    });
  });
  await t.test('embed text and multi-embed replies respect Discord aggregate limits', async () => {
    const { baseEmbed, embedLength } = require('../src/utils/embeds');
    const large = baseEmbed({ title: 'T'.repeat(256), description: 'D'.repeat(4096), footer: 'F'.repeat(2048),
      author: 'A'.repeat(256), fields: Array.from({ length: 25 }, () => ({ name: 'Name', value: 'V'.repeat(1024) })) });
    assert(embedLength(large) <= 6000);
    const i = f.interaction('');
    await i.deferReply();
    await new CommandContext({ interaction: i }).replyEmbeds([
      baseEmbed({ description: 'x'.repeat(4000) }), baseEmbed({ description: 'y'.repeat(4000) }),
    ]);
    assert.equal(i.response.embeds.length, 1);
    assert.equal(i.followups.length, 1);
  });
  await t.test('storage failure after a Discord action reports partial success explicitly', async () => {
    let performed = false;
    extraRepos.cases = { create: async () => { throw new Error('storage unavailable'); } };
    await assert.rejects(moderation.applyAction({ guild: f.guild, config: { requireReason: false }, action: 'ban',
      perform: async () => { performed = true; }, dm: false }), (error) => {
      assert.equal(error.code, 'ACTION_APPLIED_STORAGE_FAILED');
      assert.equal(error.safe, true);
      assert.match(error.message, /applied/);
      return true;
    });
    assert.equal(performed, true);
  });
  await t.test('successful non-JSON gateway response is not silently treated as empty configuration', async () => {
    await patch(globalThis, 'fetch', async () => new Response('<html>bad proxy</html>', { status: 200 }), async () => {
      const client = new HttpClient({ baseUrl: 'https://gateway.example', authToken: 'test', maxRetries: 0 });
      await assert.rejects(client.get('/config'), (error) => error.code === 'GATEWAY_INVALID_RESPONSE');
    });
  });
});
