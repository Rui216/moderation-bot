'use strict';
/* Setup gate: commands are blocked until setup completes, and setup needs Discord Administrator. Run: npm run test:setup-gate */
const path = require('path');
const root = path.resolve(__dirname, '..');
const db = require(path.join(root, 'src/db'));

let config = { configured: false, slashEnabled: true, prefixEnabled: false, prefix: '!', misc: {} };
db.repo = (name) => {
  if (name !== 'guilds') throw new Error('unexpected repo ' + name);
  return { getConfig: async () => ({ ...config }) };
};

const registry = require(path.join(root, 'src/core/registry'));
const dispatcher = require(path.join(root, 'src/core/dispatcher'));
registry.loadDirectory(path.join(root, 'src/commands'));

const appConfig = { discord: { ownerIds: ['999'], defaultPrefix: '!', enableSlashCommands: true } };
const OWNER = '1';
const MEMBER = '2';

function fakeInteraction(commandName, userId, isAdmin) {
  const replies = [];
  const guild = { id: '555', ownerId: OWNER, name: 'Test', roles: { cache: new Map(), everyone: { id: '555' } }, members: { me: null }, channels: { fetch: async () => null } };
  const member = { id: userId, user: { id: userId }, guild, roles: { cache: new Map() }, permissions: { has: (p) => isAdmin && p === 'Administrator' } };
  return {
    replies,
    isChatInputCommand: () => true,
    commandName,
    guild,
    channel: { id: '777', type: 0, send: async () => ({}), isTextBased: () => true },
    user: { id: userId, tag: 'user#0001', username: 'user' },
    member,
    client: { user: { id: '100' }, ws: { ping: 5 }, appConfig },
    options: { get: () => null, data: [] },
    reply: async (payload) => { replies.push(payload); },
    deferReply: async () => {},
    editReply: async (payload) => { replies.push(payload); },
    deferred: false,
    replied: false,
  };
}

function titleOf(replies) {
  const last = replies[replies.length - 1];
  return last && last.embeds && last.embeds[0] && last.embeds[0].title;
}

let passed = 0;
let failed = 0;
function check(label, ok) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`); } else { failed += 1; console.log(`  FAIL  ${label}`); }
}

(async () => {
  console.log('Setup gate');
  const deps = { client: null, appConfig };

  // Before setup: ordinary commands are blocked.
  config = { ...config, configured: false };
  let i = fakeInteraction('ping', MEMBER, true);
  await dispatcher.handleInteraction(deps, i);
  check('unconfigured server blocks /ping', titleOf(i.replies) === 'Setup Required');

  // Before setup: /setup is allowed through to the admin check.
  i = fakeInteraction('setup', MEMBER, false);
  await dispatcher.handleInteraction(deps, i);
  check('non-admin /setup is refused', ['Administrators Only', 'Command Failed'].includes(titleOf(i.replies)));

  // Non-admin owner is still allowed as guild owner.
  i = fakeInteraction('setup', OWNER, false);
  await dispatcher.handleInteraction(deps, i);
  check('guild owner passes the setup admin check', titleOf(i.replies) !== 'Administrators Only' && titleOf(i.replies) !== 'Command Failed');

  // Discord Administrator passes the admin check.
  i = fakeInteraction('setup', MEMBER, true);
  await dispatcher.handleInteraction(deps, i);
  check('Discord Administrator passes the setup admin check', titleOf(i.replies) !== 'Administrators Only' && titleOf(i.replies) !== 'Command Failed');

  // After setup: ordinary commands run.
  config = { ...config, configured: true };
  i = fakeInteraction('ping', MEMBER, false);
  await dispatcher.handleInteraction(deps, i);
  check('configured server runs /ping', titleOf(i.replies) !== 'Setup Required');

  console.log(`\nPassed: ${passed}\nFailed: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => { console.error('Setup gate test crashed:', error); process.exit(1); });
