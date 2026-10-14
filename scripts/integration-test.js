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

/** Per-test overrides: the guild configuration document and active punishment rows. */
let guildConfigOverride = null;
let punishmentRows = [];

/** Canned responder for the gateway transport. */
function fakeTransport(method, endpoint, options = {}) {
  gatewayCalls.push({ method, endpoint, options });

  if (endpoint.endsWith('/config')) {
    return Promise.resolve({ config: guildConfigOverride || { guildId: '111111111111111111', prefix: '!', prefixEnabled: true, requireReason: true, dmOnPunishment: true } });
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
  if (endpoint.includes('/punishments')) return Promise.resolve({ cleared: 1, punishments: punishmentRows });
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
    action: 'automod',
    moderatorId: 'system',
    reason: 'Test automod action',
  });
  const raidCall = gatewayCalls.filter((call) => call.endpoint.endsWith('/cases')).pop();
  check('system actions record a case', Boolean(raidCall));
  check('system action uses the system actor', raidCall && raidCall.options.body.moderatorId === 'system');

  section('Ban appeals');

  const appealService = require(path.join(ROOT, 'src/services/appealService.js'));
  const punishmentApi = require(path.join(ROOT, 'src/services/punishmentService.js'));
  const readinessService = require(path.join(ROOT, 'src/services/readinessService.js'));
  const setupWizard = require(path.join(ROOT, 'src/core/setupWizard.js'));

  const APPEAL_CHANNEL = '777000000000000001';
  const appealGuild = fakeGuild();
  const appealConfig = {
    ...config,
    dmOnPunishment: false,
    misc: { nickLocks: {}, appeals: { enabled: true, channelId: APPEAL_CHANNEL } },
  };
  guildConfigOverride = appealConfig;

  const banOrder = [];
  appealGuild.members.ban = (id) => { banOrder.push(`ban:${id}`); appealGuild.bansApplied.push(id); return Promise.resolve(); };
  appealGuild.channels.cache.set(APPEAL_CHANNEL, {
    id: APPEAL_CHANNEL,
    name: 'appeals',
    isTextBased: () => true,
    isDMBased: () => false,
    permissionsFor: () => ({ has: () => true }),
  });

  const appealMod = fakeMember({ id: '777777777777777777', tag: 'mod#0001', position: 10, guild: appealGuild });
  appealMod.roles.cache.set('333333333333333333', { id: '333333333333333333' });
  const appealTarget = fakeMember({ id: '123456789012345678', tag: 'target#0005', position: 1, guild: appealGuild });
  appealTarget.user.displayAvatarURL = () => 'https://cdn.discordapp.com/embed/avatars/0.png';
  const sentDms = [];
  appealTarget.user.send = (payload) => { banOrder.push('dm'); sentDms.push(payload); return Promise.resolve({}); };
  const plainMemberForAppeal = fakeMember({ id: '888888888888888888', tag: 'member#0002', position: 1, guild: appealGuild });

  const customIdsOf = (components) => components.flatMap((row) => (row.toJSON ? row.toJSON() : row).components.map((c) => c.custom_id));
  const titleOf = (embed) => (embed && embed.data ? embed.data.title : embed && embed.title);
  const fieldsOf = (embed) => (embed && embed.data ? embed.data.fields : embed && embed.fields) || [];

  // 1. Notice goes out before the Discord ban call.
  let banResult = null;
  banResult = await punishmentApi.ban(
    fakeContext({ guild: appealGuild, member: appealMod, target: appealTarget, args: [], config: appealConfig }),
    appealTarget,
    { reason: 'Spam in direct messages' },
  );
  check('appeal notice is sent before the ban is applied', JSON.stringify(banOrder) === JSON.stringify(['dm', `ban:${appealTarget.id}`]), JSON.stringify(banOrder));
  check('exactly one notice DM is sent', sentDms.length === 1, String(sentDms.length));
  check('notice carries the appeal button', sentDms.length === 1 && customIdsOf(sentDms[0].components).join() === `appeal:open:${appealGuild.id}`);
  check('ban result reports the notice as delivered', banResult && banResult.dmDelivered === true, String(banResult && banResult.dmDelivered));

  // 2. With appeals off the ban works and no appeal notice is sent.
  const offGuild = fakeGuild();
  const offOrder = [];
  offGuild.members.ban = (id) => { offOrder.push(`ban:${id}`); return Promise.resolve(); };
  const offTarget = fakeMember({ id: '123456789012345679', tag: 'off#0006', position: 1, guild: offGuild });
  offTarget.user.send = () => { offOrder.push('dm'); return Promise.resolve({}); };
  await punishmentApi.ban(
    fakeContext({ guild: offGuild, member: appealMod, target: offTarget, args: [], config: { ...config, misc: {} } }),
    offTarget,
    { reason: 'Test with appeals off' },
  );
  check('no notice when appeals are off', !offOrder.includes('dm') && offOrder.length === 1, JSON.stringify(offOrder));

  // 3. Eligibility: must be banned AND the ban must come from the bot.
  const appealChannel = {
    id: APPEAL_CHANNEL,
    isTextBased: () => true,
    isDMBased: () => false,
    send: (payload) => { appealChannel.sent.push(payload); return Promise.resolve({ id: 'appeal-msg' }); },
    sent: [],
  };
  const appealClient = {
    guilds: { cache: new Collection([[appealGuild.id, appealGuild]]) },
    channels: { fetch: (id) => Promise.resolve(id === APPEAL_CHANNEL ? appealChannel : null) },
    users: { fetch: (id) => Promise.resolve(id === appealTarget.id ? appealTarget.user : null) },
  };
  appealGuild.bans.fetch = (id) => Promise.resolve(id === appealTarget.id ? { user: appealTarget.user } : null);

  punishmentRows = [{ type: 'ban' }];
  const eligible = await appealService.checkEligibility(appealClient, appealGuild.id, appealTarget.id);
  check('bot-issued active ban is eligible', eligible.ok === true, eligible.message);

  punishmentRows = [];
  const manual = await appealService.checkEligibility(appealClient, appealGuild.id, appealTarget.id);
  check('manual Discord ban is refused', manual.ok === false && /not issued by the bot/.test(manual.message), manual.message);

  punishmentRows = [{ type: 'ban' }];
  const notBanned = await appealService.checkEligibility(appealClient, appealGuild.id, '123456789012345690');
  check('user who is not banned is refused', notBanned.ok === false, notBanned.message);

  // 4. Member presses Appeal in DMs: a modal opens.
  const interactionFor = (customId, extra = {}) => {
    const state = { replies: [], messageEdits: [], modal: null };
    const interaction = {
      customId,
      user: appealTarget.user,
      guild: null,
      member: null,
      deferred: false,
      replied: false,
      state,
      isButton: () => false,
      isModalSubmit: () => false,
      inGuild: () => false,
      deferReply: () => { interaction.deferred = true; return Promise.resolve(); },
      deferUpdate: () => { interaction.deferred = true; return Promise.resolve(); },
      reply: (payload) => { interaction.replied = true; state.replies.push(payload); return Promise.resolve(); },
      editReply: (payload) => { state.replies.push(payload); return Promise.resolve(); },
      showModal: (modal) => { state.modal = modal; return Promise.resolve(); },
      message: {
        embeds: [{ title: 'Ban Appeal', fields: [] }],
        edit: (payload) => { state.messageEdits.push(payload); return Promise.resolve(); },
      },
      ...extra,
    };
    return interaction;
  };

  const openInteraction = interactionFor(`appeal:open:${appealGuild.id}`, { isButton: () => true });
  const consumedOpen = await appealService.handleInteraction(appealClient, { appConfig: appConfig }, openInteraction);
  check('appeal button is consumed', consumedOpen === true);
  check('appeal button opens a modal', Boolean(openInteraction.state.modal) && openInteraction.state.modal.toJSON().custom_id === `appeal:submit:${appealGuild.id}`);

  // 5. Modal submitted: the appeal is posted to the staff channel with decision buttons.
  punishmentRows = [{ type: 'ban' }];
  const submitInteraction = interactionFor(`appeal:submit:${appealGuild.id}`, {
    isModalSubmit: () => true,
    fields: { getTextInputValue: () => 'I was banned by mistake, I did not send that message.' },
  });
  await appealService.handleInteraction(appealClient, { appConfig: appConfig }, submitInteraction);
  check('appeal is posted to the appeals channel', appealChannel.sent.length === 1);
  const posted = appealChannel.sent[0];
  check('posted appeal has approve and deny buttons for the member',
    posted && customIdsOf(posted.components).join() === `appeal:approve:${appealGuild.id}:${appealTarget.id},appeal:deny:${appealGuild.id}:${appealTarget.id}`,
    posted ? customIdsOf(posted.components).join() : 'none');
  check('member is told the appeal was sent', titleOf(submitInteraction.state.replies.at(-1).embeds[0]) === 'Appeal Sent');

  // 6. Second submission inside the cooldown is refused.
  const retry = interactionFor(`appeal:submit:${appealGuild.id}`, {
    isModalSubmit: () => true,
    fields: { getTextInputValue: () => 'Please look again at this, it was a mistake.' },
  });
  await appealService.handleInteraction(appealClient, { appConfig: appConfig }, retry);
  check('second appeal inside the cooldown is refused', appealChannel.sent.length === 1 && titleOf(retry.state.replies.at(-1).embeds[0]) === 'Appeal Already Sent');

  // 7. Staff decisions. A plain member cannot decide.
  const unbanBefore = gatewayCalls.filter((call) => call.endpoint.endsWith('/cases') && call.options.body && call.options.body.action === 'unban').length;
  const plainApprove = interactionFor(`appeal:approve:${appealGuild.id}:${appealTarget.id}`, {
    isButton: () => true, inGuild: () => true, guild: appealGuild, member: plainMemberForAppeal,
  });
  await appealService.handleInteraction(appealClient, { appConfig: appConfig }, plainApprove);
  const unbanAfterPlain = gatewayCalls.filter((call) => call.endpoint.endsWith('/cases') && call.options.body && call.options.body.action === 'unban').length;
  check('a plain member cannot approve an appeal', unbanAfterPlain === unbanBefore && titleOf(plainApprove.state.replies.at(-1).embeds[0]) === 'Not Allowed');

  // Approve as a moderator: unban runs through the normal pipeline.
  const dmBeforeApprove = sentDms.length;
  const approve = interactionFor(`appeal:approve:${appealGuild.id}:${appealTarget.id}`, {
    isButton: () => true, inGuild: () => true, guild: appealGuild, member: appealMod,
  });
  await appealService.handleInteraction(appealClient, { appConfig: appConfig }, approve);
  const unbanAfter = gatewayCalls.filter((call) => call.endpoint.endsWith('/cases') && call.options.body && call.options.body.action === 'unban').length;
  check('approve records an unban case', unbanAfter === unbanBefore + 1);
  check('approve DMs the member the result, even with punishment DMs off', sentDms.length === dmBeforeApprove + 1, `${sentDms.length} vs ${dmBeforeApprove}`);
  const approveEdit = approve.state.messageEdits.at(-1);
  const decisionField = approveEdit ? fieldsOf(approveEdit.embeds[0]).find((field) => field.name === 'Decision') : null;
  check('approve updates the staff message with the decision and removes buttons',
    Boolean(decisionField) && /Approved by mod#0001/.test(decisionField.value) && approveEdit.components.length === 0,
    decisionField ? decisionField.value : 'no decision');

  // Deny as a moderator: member is DMed, no unban.
  const unbanBeforeDeny = unbanAfter;
  const deny = interactionFor(`appeal:deny:${appealGuild.id}:${appealTarget.id}`, {
    isButton: () => true, inGuild: () => true, guild: appealGuild, member: appealMod,
  });
  const dmCountBeforeDeny = sentDms.length;
  await appealService.handleInteraction(appealClient, { appConfig: appConfig }, deny);
  const denyEdit = deny.state.messageEdits.at(-1);
  const denyField = denyEdit ? fieldsOf(denyEdit.embeds[0]).find((field) => field.name === 'Decision') : null;
  check('deny sends the member a decision DM', sentDms.length === dmCountBeforeDeny + 1, `${sentDms.length} vs ${dmCountBeforeDeny}`);
  check('deny records the decision and does not unban',
    Boolean(denyField) && /Denied by mod#0001/.test(denyField.value)
      && gatewayCalls.filter((call) => call.endpoint.endsWith('/cases') && call.options.body && call.options.body.action === 'unban').length === unbanBeforeDeny);

  // 8. Readiness: appeals on without a channel is a problem.
  const readinessNoChannel = readinessService.buildChecks({
    guild: appealGuild,
    me: appealGuild.members.me,
    settings: { appealsEnabled: true, appealsChannelId: null },
  });
  check('readiness flags appeals with no channel', readinessNoChannel.some((check) => check.label === 'Appeals channel' && check.status === 'fail'));

  // 9. Setup wizard: appeals step, toggle, channel select, summary, save.
  section('Setup wizard');
  const wizardSent = [];
  const wizardChannel = {
    id: '555555555555555555',
    send: (payload) => { wizardSent.push(payload); return Promise.resolve({ id: 'wizard-msg' }); },
    messages: { fetch: () => Promise.resolve(null) },
  };
  guildConfigOverride = { ...appealConfig, misc: { nickLocks: {}, tickets: { categoryId: 'cat-1', supportRoleId: 'role-1' }, appeals: { enabled: false, channelId: null } } };
  const wizardClient = { appConfig: { discord: { defaultPrefix: '!' } } };
  // Earlier tests cached the guild config; the wizard must read the new document.
  require(path.join(ROOT, 'src/db')).repo('guilds').invalidate(appealGuild.id);
  const wizardInteraction = (customId, extra = {}) => ({
    customId,
    guild: appealGuild,
    user: appealMod.user,
    isButton: () => customId.startsWith('setup:') && !extra.isChannelSelectMenu,
    isStringSelectMenu: () => false,
    isChannelSelectMenu: () => Boolean(extra.isChannelSelectMenu),
    values: extra.values || [],
    deferUpdate: () => Promise.resolve(),
    reply: () => Promise.resolve(),
    deferred: false,
    replied: false,
  });

  await setupWizard.start({ client: wizardClient, guild: appealGuild, member: appealMod, channel: wizardChannel, config: guildConfigOverride });
  const wizard = setupWizard.get(appealGuild.id, appealMod.id);
  check('wizard has an appeals step after lockdown', setupWizard.STEPS.indexOf('appeals') === setupWizard.STEPS.indexOf('lockdown') + 1);
  wizard.stepIndex = setupWizard.STEPS.indexOf('appeals');
  await setupWizard.render(wizard);
  const appealsScreen = wizardSent.at(-1).embeds[0];
  check('appeals step footer uses the real step number', titleOf(appealsScreen) === 'Ban Appeals' && appealsScreen.footer.text.includes(`Step ${setupWizard.STEPS.indexOf('appeals') + 1} of ${setupWizard.STEPS.length}`), appealsScreen.footer && appealsScreen.footer.text);

  await setupWizard.handleComponent(wizardClient, wizardInteraction('setup:appeals:toggle'));
  check('toggle turns appeals on in the session', wizard.data.appealsEnabled === true);
  await setupWizard.handleComponent(wizardClient, wizardInteraction('setup:appeals:channel', { isChannelSelectMenu: true, values: [APPEAL_CHANNEL] }));
  check('channel select stores the appeals channel', wizard.data.appealsChannelId === APPEAL_CHANNEL);

  wizard.stepIndex = setupWizard.STEPS.length - 1;
  await setupWizard.render(wizard);
  const summary = wizardSent.at(-1).embeds[0];
  const summaryFields = fieldsOf(summary);
  check('summary shows appeals and a readiness field', summaryFields.some((f) => f.name === 'Ban Appeals' && /APPEAL/i.test(f.value) === false && f.value.includes(APPEAL_CHANNEL))
    && summaryFields.some((f) => f.name === 'Readiness'));
  check('summary footer shows the final step number', summary.footer.text.endsWith(`Step ${setupWizard.STEPS.length} of ${setupWizard.STEPS.length}`), summary.footer.text);

  gatewayCalls.length = 0;
  await setupWizard.handleComponent(wizardClient, wizardInteraction('setup:save'));
  const saveCall = gatewayCalls.filter((call) => call.method === 'PUT' && call.endpoint.endsWith('/config')).pop();
  const savedBody = saveCall ? (saveCall.options.body || saveCall.options) : {};
  const savedPatch = savedBody.patch || savedBody;
  check('save writes misc.appeals with the chosen channel', Boolean(savedPatch.misc) && savedPatch.misc.appeals.enabled === true && savedPatch.misc.appeals.channelId === APPEAL_CHANNEL, JSON.stringify(savedPatch.misc));
  check('save keeps other misc keys (tickets, nickname locks)', Boolean(savedPatch.misc) && savedPatch.misc.tickets && savedPatch.misc.tickets.categoryId === 'cat-1' && savedPatch.misc.nickLocks !== undefined);
  const automodCall = gatewayCalls.filter((call) => call.endpoint.endsWith('/automod') && call.method !== 'GET').pop();
  check('save no longer writes a raid block', automodCall ? !JSON.stringify(automodCall.options).includes('"raid"') : true);
  check('wizard session is closed after save', !setupWizard.get(appealGuild.id, appealMod.id));

  // 10. Utility commands.
  section('Utility commands');
  const roleInfoCommand = registry.get('roleinfo');
  const channelInfoCommand = registry.get('channelinfo');
  check('roleinfo and channelinfo are registered', Boolean(roleInfoCommand) && Boolean(channelInfoCommand));

  const roleObject = {
    id: '444555666777888000',
    name: 'Moderators',
    position: 5,
    color: 0x5865f2,
    hexColor: '#5865f2',
    hoist: true,
    mentionable: false,
    managed: false,
    editable: true,
    createdTimestamp: Date.now() - 86400000,
    permissions: { toArray: () => ['ManageMessages', 'KickMembers', 'ViewChannel', 'SendMessages'] },
    members: new Collection([['1', {}], ['2', {}]]),
  };
  appealGuild.roles.cache.set(roleObject.id, roleObject);
  appealGuild.roles.fetch = (query) => Promise.resolve(appealGuild.roles.cache.get(query) || null);
  const roleCtx = fakeContext({ guild: appealGuild, member: appealMod, target: appealTarget, args: [roleObject.id], config });
  await roleInfoCommand.execute(roleCtx);
  const roleEmbed = roleCtx.replies[0] && roleCtx.replies[0].embeds[0];
  const notableField = roleEmbed ? fieldsOf(roleEmbed).find((f) => f.name === 'Notable Permissions') : null;
  check('roleinfo shows notable permissions and member count', titleOf(roleEmbed) === 'Role: Moderators'
    && Boolean(notableField) && notableField.value.includes('ManageMessages') && notableField.value.includes('KickMembers')
    && fieldsOf(roleEmbed).some((f) => f.name === 'Members' && f.value.startsWith('2')));

  const channelObject = {
    id: '555555555555555001',
    name: 'general',
    type: 0,
    parent: { name: 'Text Channels' },
    rawPosition: 1,
    createdTimestamp: Date.now() - 86400000,
    permissionOverwrites: { cache: new Collection() },
    nsfw: false,
    rateLimitPerUser: 10,
    topic: 'Be kind',
    isTextBased: () => true,
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
  };
  const channelCtx = fakeContext({ guild: appealGuild, member: appealMod, target: appealTarget, args: [], config: appealConfig });
  channelCtx.channel = channelObject;
  await channelInfoCommand.execute(channelCtx);
  const channelEmbed = channelCtx.replies[0] && channelCtx.replies[0].embeds[0];
  const slowField = channelEmbed ? fieldsOf(channelEmbed).find((f) => f.name === 'Slowmode') : null;
  const accessField = channelEmbed ? fieldsOf(channelEmbed).find((f) => f.name === 'Bot Access') : null;
  check('channelinfo reports slowmode, category, and bot access', titleOf(channelEmbed) === 'Channel: general'
    && slowField && slowField.value === '10 seconds' && accessField && accessField.value.startsWith('Can view'));

  // Readiness is shared with doctor: the same check returns the same result.
  const doctorStyle = readinessService.buildChecks({ guild: appealGuild, me: appealGuild.members.me, settings: { appealsEnabled: false } });
  check('readiness reports appeals as off by default', doctorStyle.some((c) => c.label === 'Ban appeals' && c.status === 'ok'));

  // Restore the default config for the smoke tests.
  guildConfigOverride = null;
  punishmentRows = [];

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
    lockdown: ['Spam wave'],
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
    roleinfo: [],
    channelinfo: [],
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
