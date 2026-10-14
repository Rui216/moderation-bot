'use strict';
/* Ticket queue: simultaneous opens in one server get separate numbers. Run: npm run test:ticket-queue */
const path = require('path');
const root = path.resolve(__dirname, '..');
const db = require(path.join(root, 'src/db'));
const { ChannelType } = require(path.join(root, 'node_modules', 'discord.js'));

// Store that simulates a slow database, so the race is real.
const store = { misc: {} };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
db.repo = (name) => {
  if (name !== 'guilds') throw new Error('unexpected repo ' + name);
  return {
    async getConfig() { await delay(5); return { misc: JSON.parse(JSON.stringify(store.misc)) }; },
    async updateConfig(_id, patch) { await delay(5); if (patch.misc) store.misc = JSON.parse(JSON.stringify(patch.misc)); return {}; },
  };
};

const ticketService = require(path.join(root, 'src/services/ticketService'));
const { withLock, activeKeys } = require(path.join(root, 'src/utils/keyedLock'));

const CAT = '100000000000000001';
const ROLE = '100000000000000004';
const created = [];
let nextId = 1000;
const channels = new Map();
channels.set(CAT, { id: CAT, type: ChannelType.GuildCategory });

function makeChannel(id, props) {
  const c = { id, type: ChannelType.GuildText, sent: [], deleted: false, isTextBased: () => true,
    send: async (p) => { c.sent.push(p); return p; },
    delete: async () => { c.deleted = true; channels.delete(id); }, ...props };
  channels.set(id, c);
  return c;
}

const guild = {
  id: '999', name: 'Test',
  roles: { everyone: { id: '999' } },
  channels: {
    fetch: async (id) => channels.get(id) || null,
    create: async (opts) => {
      await delay(10); // channel creation takes time, which is when races happen
      const c = makeChannel(String(nextId++), { name: opts.name, parent: opts.parent });
      created.push(c.name);
      return c;
    },
  },
};
const client = { user: { id: '777' } };

function openFor(userId) {
  const interaction = { guild, user: { id: userId, tag: `user${userId}#0001` }, member: null, channelId: '200',
    deferReply: async () => {}, editReply: async () => {}, reply: async () => {}, deferred: true, replied: false };
  return ticketService.handleComponent(client, { ...interaction, customId: 'ticket:open' });
}

let passed = 0;
let failed = 0;
function check(label, ok) {
  if (ok) { passed += 1; console.log(`  PASS  ${label}`); } else { failed += 1; console.log(`  FAIL  ${label}`); }
}

(async () => {
  console.log('Ticket queue');
  store.misc = { tickets: { categoryId: CAT, supportRoleId: ROLE, logChannelId: null, counter: 0, open: {} } };

  // Three different members press Open Ticket at the same moment.
  await Promise.all([openFor('11'), openFor('22'), openFor('33')]);
  const tickets = store.misc.tickets;
  check('three simultaneous opens create three tickets', Object.keys(tickets.open).length === 3);
  check('counter ends at 3 with no skipped or repeated numbers', tickets.counter === 3);
  const numbers = Object.values(tickets.open).map((t) => t.number).sort();
  check('ticket numbers are 1, 2, 3', numbers.join(',') === '1,2,3');
  check('channel names are unique', new Set(created).size === created.length);

  // The same member pressing twice at once gets one ticket.
  await Promise.all([openFor('44'), openFor('44')]);
  const count44 = Object.values(store.misc.tickets.open).filter((t) => t.userId === '44').length;
  check('one member pressing twice gets exactly one ticket', count44 === 1);

  check('no lock is left held', activeKeys() === 0);

  // A failure inside the lock does not block later work.
  await withLock('probe', async () => { throw new Error('boom'); }).catch(() => null);
  const after = await withLock('probe', async () => 'ok');
  check('a failed task does not block the next one', after === 'ok');

  console.log(`\nPassed: ${passed}\nFailed: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => { console.error('Ticket queue test crashed:', error); process.exit(1); });
