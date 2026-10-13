'use strict';

/**
 * Integration test for the moderation pipeline.
 *
 * A fake Discord object graph and a fake gateway transport are wired into the
 * real modules, then real commands are executed end to end. This exercises:
 *
 *   - the command registry and dispatcher argument handling
 *   - permission and hierarchy guards
 *   - the moderation pipeline (case creation, punishment state, expiry task)
 *   - embed construction
 *   - error classification for a refused Discord action
 *
 * Nothing here touches the network or Discord; the gateway transport is
 * replaced with a canned responder.
 *
 * Usage: npm run test:integration
 */

const path = require('path');

const { Collection } = require('discord.js');

const ROOT = path.join(__dirname, '..');

let passed = 0;
const failures = [];

function check(name, condition, details) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${details ? ` - ${details}` : ''}`);
}

function section(title) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------------ fakes */

/** Records every gateway request so assertions can inspect the payloads. */
const gatewayCalls = [];

/** Canned responder for the gateway transport. */
function fakeTransport(method, endpoint, options = {}) {
  gatewayCalls.push({ method, endpoint, options });

  if (endpoint.endsWith('/config')) {
    return Promise.resolve({ config: { guildId: '111111111111111111', prefix: '!', prefixEnabled: true, requireReason: true, dmOnPunishment: true } });
  }
  if (endpoint.endsWith('/cases') && method === 'POST') {
    return Promise.resolve({ case: { caseNumber: 7, action: options.body.action, status: 'active' }, caseNumber: 7 });
  }
  if (endpoint.endsWith('/logging')) return Promise.resolve({ logging: { channels: {}, events: {} } });
  if (endpoint.endsWith('/automod')) return Promise.resolve({ automod: {} });
  if (endpoint.endsWith('/notes') && method === 'POST') {
    return Promise.resolve({ note: { id: 5, userId: options.body.userId, authorId: options.body.authorId, content: options.body.content } });
  }
  if (endpoint.includes('/warnings/count')) return Promise.resolve({ active: 2, total: 3 });
  if (endpoint.includes('/warnings')) return Promise.resolve({ warnings: [] });
  if (endpoint.includes('/tasks')) return Promise.resolve({ tasks: [], cancelled: 0 });
  if (endpoint.includes('/punishments')) return Promise.resolve({ cleared: 1, punishments: [] });
  if (endpoint.includes('/strikes')) return Promise.resolve({ strikes: 3, removed: 3 });
  if (endpoint.includes('/stats')) return Promise.resolve({ stats: { cases: 1, activeWarnings: 1, notes: 0, pendingTasks: 0 } });
  return Promise.resolve({});
}

/** Minimal member object with the surface the services use. */
function fakeMember({ id, tag, position = 1, isOwner = false, guild }) {
  const member = {
    id,
    user: { id, tag, username: tag.split('#')[0], bot: false, send: () => Promise.resolve({}) },
    displayName: tag,
    nickname: null,
    roles: {
      cache: new Collection(),
      highest: { position },
      add: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    },
    permissions: { has: () => false },
    guild,
    kickable: true,
    bannable: true,
    manageable: true,
    displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png',
    timeout: (duration) => { member.timeoutCalls.push(duration); return Promise.resolve(); },
    kick: () => { guild.kicksApplied.push(id); return Promise.resolve(); },
    timeoutCalls: [],
    setNickname: () => Promise.resolve(),
    isCommunicationDisabled: () => false,
    send: () => Promise.resolve({}),
  };
  if (isOwner) guild.ownerId = id;
  // Register in the guild cache so member resolution behaves as in production.
  if (guild && guild.members && guild.members.cache) guild.members.cache.set(id, member);
  return member;
}

/** Minimal guild object. */
function fakeGuild() {
  const guild = {
    id: '111111111111111111',
    name: 'Test Guild',
    ownerId: '999999999999999999',
    memberCount: 42,
    iconURL: () => null,
    createdTimestamp: Date.now() - 86400000,
    roles: {
      everyone: { id: '111111111111111111' },
      cache: new Collection(),
      fetch: () => Promise.resolve(null),
      create: () => Promise.resolve({ id: '444444444444444444', name: 'Muted', permissions: { has: () => false }, position: 1 }),
    },
    members: {
      me: null,
      cache: new Collection(),
      fetch: (query) => Promise.resolve(guild.members.cache.get(query) || null),
      ban: (id) => { guild.bansApplied.push(id); return Promise.resolve(); },
      unban: (id) => Promise.resolve(),
    },
    bans: {
      fetch: () => Promise.resolve(new Collection()),
    },
    channels: {
      cache: new Collection(),
      fetch: () => Promise.resolve(null),
    },
    bansApplied: [],
    kicksApplied: [],
    fetchAuditLogs: () => Promise.resolve({ entries: new Collection() }),
    membersMePermissions: ['BanMembers', 'KickMembers', 'ModerateMembers', 'ManageRoles', 'ManageChannels', 'ManageMessages'],
  };

  guild.members.me = {
    id: '222222222222222222',
    roles: { highest: { position: 50 } },
    permissions: { has: (permission) => guild.membersMePermissions.includes(permission) },
  };

  return guild;
}

/** Minimal command context. */
function fakeContext({ guild, member, target, args, config }) {
  const replies = [];
  return {
    guild,
    member,
    moderator: member,
    author: member.user,
    client: {
      user: { id: '222222222222222222' },
      guilds: { cache: new Collection() },
      ws: { ping: 42 },
      rest: { put: () => Promise.resolve({}) },
    },
    channel: {
      id: '555555555555555555',
      isTextBased: () => true,
      name: 'general',
      type: 0,
      send: (payload) => { replies.push(payload); return Promise.resolve({ id: '666666666666666666', delete: () => Promise.resolve() }); },
      messages: { fetch: () => Promise.resolve(null) },
      permissionOverwrites: { cache: new Collection(), edit: () => Promise.resolve() },
      bulkDelete: () => Promise.resolve(new Collection([['1', {}], ['2', {}]])),
      setRateLimitPerUser: () => Promise.resolve(),
    },
    interaction: null,
    isSlash: false,
    args,
    rawArgs: args.join(' '),
    flags: {},
    config,
    appConfig: {
      discord: { ownerIds: [], defaultPrefix: '!' },
      limits: { maxPurgeCount: 1000, maxTimeoutMs: 28 * 24 * 60 * 60 * 1000, maxTempbanMs: 365 * 24 * 60 * 60 * 1000 },
    },
    limits: { maxPurgeCount: 1000, maxTimeoutMs: 28 * 24 * 60 * 60 * 1000 },
    rawReason: '',
    replies,
    resolveMember: (query) => Promise.resolve(query === target.id || query === `<@${target.id}>` ? target : null),
    resolveUser: (query) => Promise.resolve(query === target.id ? target.user : null),
    resolveChannel: () => Promise.resolve(null),
    resolveRole: () => Promise.resolve(null),
    replyEmbed: (embed) => { replies.push({ embeds: [embed] }); return Promise.resolve(null); },
    replyEmbeds: (embeds) => { replies.push({ embeds }); return Promise.resolve(null); },
    replyResult: (result) => { replies.push({ embeds: [result.embed] }); return Promise.resolve(null); },
    success: () => Promise.resolve(null),
    info: () => Promise.resolve(null),
    notice: () => Promise.resolve(null),
    error: (title, description) => { replies.push({ embeds: [{ title, description }] }); return Promise.resolve(null); },
    handleError: (error) => { replies.push({ error }); return Promise.resolve(null); },
    canActOn: () => true,
  };
}

/* ------------------------------------------------------------------- tests */

async function main() {
  // The environment is validated lazily; provide the minimum the data layer needs.
  process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'fake-token-for-offline-tests.not-a-real-credential.x';
  process.env.WORKER_BASE_URL = process.env.WORKER_BASE_URL || 'https://gateway.example.workers.dev';
  process.env.WORKER_AUTH_TOKEN = process.env.WORKER_AUTH_TOKEN || 'integration-test-token-value-0123456789';
  process.env.LOG_LEVEL = 'error';

  const { initDatabase, getGateway } = require(path.join(ROOT, 'src/db'));
  const { loadConfig } = require(path.join(ROOT, 'src/config/env'));
  const registry = require(path.join(ROOT, 'src/core/registry.js'));
  const permissionService = require(path.join(ROOT, 'src/services/permissionService.js'));
  const hierarchyService = require(path.join(ROOT, 'src/services/hierarchyService.js'));
  const moderationService = require(path.join(ROOT, 'src/services/moderationService.js'));
  const rateLimitService = require(path.join(ROOT, 'src/services/rateLimitService.js'));
  const { ValidationError, HierarchyError } = require(path.join(ROOT, 'src/utils/errors.js'));

  const appConfig = loadConfig({ exitOnError: false });
  initDatabase(appConfig);
  rateLimitService.configure(appConfig);

  // Replace the transport with the canned responder.
  const gateway = getGateway();
  gateway.http.request = (method, endpoint, options) => fakeTransport(method, endpoint, options);

  registry.loadDirectory(path.join(ROOT, 'src/commands'));

  section('Registry and permissions');

  check('ban command is registered', Boolean(registry.get('ban')));
  check('alias resolves', registry.get('tban') && registry.get('tban').name === 'tempban');
  check('unknown command returns null', registry.get('definitelynotacommand') === null);

  const guild = fakeGuild();
  const config = {
    prefix: '!',
    prefixEnabled: true,
    requireReason: true,
    dmOnPunishment: false,
    modRoleIds: ['333333333333333333'],
    adminRoleIds: [],
    trustedRoleIds: [],
    lockdown: { roleIds: [], channelIds: [], autoUnlockMinutes: 0 },
    misc: { nickLocks: {} },
  };

  const moderator = fakeMember({ id: '777777777777777777', tag: 'mod#0001', position: 10, guild });
  moderator.roles.cache.set('333333333333333333', { id: '333333333333333333' });

  const plainMember = fakeMember({ id: '888888888888888888', tag: 'member#0002', position: 1, guild });

  const testRole = {
    id: '444555666777888999',
    name: 'Verified',
    position: 5,
    managed: false,
    permissions: { has: () => false },
    hexColor: '#5865f2',
    members: { size: 1 },
  };
  guild.roles.cache.set(testRole.id, testRole);
  guild.roles.fetch = (query) => Promise.resolve(guild.roles.cache.get(query) || null);

  check('moderator role grants moderator level', permissionService.resolveLevel(moderator, config, []).level === 'moderator');
  check('plain member is everyone', permissionService.resolveLevel(plainMember, config, []).level === 'everyone');
  check('guild owner is owner level', permissionService.resolveLevel({ ...plainMember, id: guild.ownerId, guild }, config, []).level === 'owner');
  check('bot owner list grants owner level', permissionService.resolveLevel(plainMember, config, [plainMember.id]).level === 'owner');

  const banCommand = registry.get('ban');
  check('plain member cannot run ban', permissionService.canRunCommand({ member: plainMember, config, command: banCommand, ownerIds: [] }).allowed === false);
  check('moderator can run ban', permissionService.canRunCommand({ member: moderator, config, command: banCommand, ownerIds: [] }).allowed === true);
  check('moderator cannot run setup', permissionService.canRunCommand({ member: moderator, config, command: registry.get('setup'), ownerIds: [] }).allowed === false);

  section('Hierarchy');

  const highMember = fakeMember({ id: '999000000000000001', tag: 'admin#0003', position: 20, guild });
  let hierarchyError = null;
  try {
    hierarchyService.assertCanActOn(moderator, highMember);
  } catch (error) {
    hierarchyError = error;
  }
  check('acting on a higher member is refused', hierarchyError instanceof HierarchyError);

  let ownerError = null;
  const ownerTarget = fakeMember({ id: guild.ownerId, tag: 'owner#0004', position: 100, guild });
  try {
    hierarchyService.assertCanActOn(moderator, ownerTarget);
  } catch (error) {
    ownerError = error;
  }
  check('acting on the guild owner is refused', ownerError instanceof HierarchyError);

  section('Command execution');

  const target = fakeMember({ id: '123456789012345678', tag: 'target#0005', position: 1, guild });
  const ctx = fakeContext({ guild, member: moderator, target, args: [target.id, 'Breaking', 'server', 'rules'], config });

  await banCommand.execute(ctx);

  const reply = ctx.replies[0];
  const embed = reply && reply.embeds ? reply.embeds[0] : null;

  check('ban produced an embed reply', Boolean(embed));
  check('embed title states the action', embed.title === 'Member Banned', embed.title);
  check('embed is colour coded red', embed.color === 0xed4245, String(embed.color));
  check('embed lists the target', embed.fields.some((field) => field.name === 'Target'));
  check('embed lists the moderator', embed.fields.some((field) => field.name === 'Moderator'));
  check('embed lists the reason', embed.fields.some((field) => field.name === 'Reason' && field.value.includes('Breaking')));
  check('embed lists the case id', embed.fields.some((field) => field.name === 'Case ID' && field.value === '#7'));
  check('embed carries a case footer', Boolean(embed.footer && embed.footer.text.includes('#7')));
  check('discord ban was called', guild.bansApplied.includes(target.id));

  const caseCall = gatewayCalls.find((call) => call.endpoint.endsWith('/cases') && call.method === 'POST');
  check('a case was persisted', Boolean(caseCall));
  check('case action is ban', caseCall && caseCall.options.body.action === 'ban');
  check('case records the moderator', caseCall && caseCall.options.body.moderatorId === moderator.id);
  check('case records the punishment state', caseCall && caseCall.options.body.punishment && caseCall.options.body.punishment.type === 'ban');
  check('permanent ban schedules no task', caseCall && !caseCall.options.body.task);

  section('Validation and rate limiting');

  let reasonError = null;
  const noReasonCtx = fakeContext({ guild, member: moderator, target, args: [target.id], config });
  try {
    await banCommand.execute(noReasonCtx);
  } catch (error) {
    reasonError = error;
  }
  check('missing reason is refused when required', reasonError instanceof ValidationError);

  const tempbanCtx = fakeContext({ guild, member: moderator, target, args: [target.id, '2h', 'Cooling off'], config });
  await registry.get('tempban').execute(tempbanCtx);
  const tempbanCall = gatewayCalls.filter((call) => call.endpoint.endsWith('/cases') && call.method === 'POST').pop();
  check('tempban records a duration', tempbanCall && tempbanCall.options.body.durationMs === 2 * 60 * 60 * 1000);
  check('tempban schedules an unban task', tempbanCall && tempbanCall.options.body.task && tempbanCall.options.body.task.type === 'unban');
  check('tempban expiry is in the future', tempbanCall && tempbanCall.options.body.task.runAt > Date.now());

  let muteRecorded = false;
  const muteCtx = fakeContext({ guild, member: moderator, target, args: [target.id, '10m', 'Spamming'], config });
  await registry.get('mute').execute(muteCtx);
  muteRecorded = target.timeoutCalls.includes(10 * 60 * 1000);
  check('mute uses the native timeout', muteRecorded);

  let limited = false;
  try {
    for (let index = 0; index < 50; index += 1) {
      rateLimitService.consume(guild.id, member_id(), 'command');
    }
  } catch {
    limited = true;
  }
  check('rate limiter refuses a burst', limited);

  function member_id() {
    return '777777777777777777';
  }

  section('Error classification');

  const failingGuild = fakeGuild();
  failingGuild.members.ban = () => Promise.reject(Object.assign(new Error('Missing Permissions'), { code: 50013 }));
  const failingTarget = fakeMember({ id: '123456789012345678', tag: 'target#0005', position: 1, guild: failingGuild });
  const failingCtx = fakeContext({ guild: failingGuild, member: moderator, target: failingTarget, args: [failingTarget.id, 'Reason'], config });

  let classified = null;
  try {
    await registry.get('ban').execute(failingCtx);
  } catch (error) {
    classified = error;
  }
  check('discord permission failure becomes a hierarchy error', classified instanceof HierarchyError);
  check('failure message is safe for users', Boolean(classified && classified.safe === true));

  await moderationService.recordSystemAction({
    guild,
    action: 'raid',
    moderatorId: 'system',
    reason: 'Test raid',
  });
  const raidCall = gatewayCalls.filter((call) => call.endpoint.endsWith('/cases')).pop();
  check('system actions record a case', Boolean(raidCall));
  check('system action uses the system actor', raidCall && raidCall.options.body.moderatorId === 'system');

  section('Command smoke tests');

  const h = require(path.join(ROOT, 'src/utils/args.js'));

  /** Arguments that let each command reach its own logic. */
  const smokeArgs = {
    kick: [target.id, 'reason'],
    ban: [target.id, 'reason'],
    tempban: [target.id, '2h', 'reason'],
    softban: [target.id, 'reason'],
    unban: [target.id, 'reason'],
    mute: [target.id, '10m', 'reason'],
    tempmute: [target.id, '10m', 'reason'],
    unmute: [target.id, 'reason'],
    warn: [target.id, 'reason'],
    warnings: [target.id],
    delwarn: ['1', 'reason'],
    clearwarnings: [target.id, 'reason'],
    note: [target.id, 'watch this member'],
    notes: [target.id],
    delnote: ['1'],
    case: ['7'],
    modlog: [target.id],
    purge: ['10', 'cleanup'],
    slowmode: ['5', 'calm down'],
    lockdown: ['raid'],
    unlock: ['resolved'],
    forcenick: [target.id, 'Quiet', 'reason'],
    nicklock: [target.id, 'Quiet', 'reason'],
    addrole: [target.id, testRole.id, 'reason'],
    removerole: [target.id, testRole.id, 'reason'],
    temprole: [target.id, testRole.id, '1h', 'reason'],
    setup: [],
    config: [],
    prefix: ['?'],
    logconfig: ['disable', 'message_delete'],
    automod: ['rule', 'invites', 'on', 'delete'],
    export: ['10'],
    syncslash: [],
    help: [],
    ping: [],
    whois: [],
    serverinfo: [],
    stats: [],
  };

  const { isUserError } = require(path.join(ROOT, 'src/utils/errors.js'));

  for (const command of registry.all()) {
    const args = smokeArgs[command.name] === undefined ? [target.id, 'reason'] : smokeArgs[command.name];
    const smokeCtx = fakeContext({ guild, member: moderator, target, args, config });

    // Give member-role commands a role to find when they ask for one.
    smokeCtx.resolveRole = () => Promise.resolve(testRole);

    try {
      await command.execute(smokeCtx);
      check(`"${command.name}" executes without an unexpected error`, true);
    } catch (error) {
      // A refused validation is acceptable; anything else is a bug.
      if (isUserError(error)) {
        check(`"${command.name}" executes without an unexpected error`, true);
      } else {
        check(`"${command.name}" executes without an unexpected error`, false, `${error && error.name}: ${error && error.message}`);
      }
    }
  }

  check('help lists only permitted commands', registry.visibleFor(plainMember, config, []).length < registry.visibleFor(moderator, config, []).length);
  check('duration helper parses two-part input', h.takeDuration(['1d', '2h', 'reason']).durationMs === 26 * 60 * 60 * 1000);
  check('duration helper reports an out-of-range duration', h.takeDuration(['99h'], { maxMs: 3600000 }).invalid === 'too-long');

  section('Result');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failures.length}`);

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  console.log('\nIntegration checks passed.');
}

main().catch((error) => {
  console.error('Integration test crashed:', error && error.message);
  console.error(error && error.stack);
  process.exit(1);
});
