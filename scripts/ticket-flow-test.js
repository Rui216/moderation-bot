'use strict';
/* Ticket open/close flow against an in-memory guild. Run: npm run test:tickets */
const path = require('path');
const root = path.resolve(__dirname, '..');
const db = require(path.join(root, 'src/db'));
// In-memory guild config store standing in for the Worker-backed repository.
const store = { misc: {} };
const guildsRepo = {
  async getConfig() { return { misc: JSON.parse(JSON.stringify(store.misc)) }; },
  async updateConfig(_id, patch) { if (patch.misc) store.misc = JSON.parse(JSON.stringify(patch.misc)); return {}; },
};
db.repo = (name) => { if (name !== 'guilds') throw new Error('unexpected repo ' + name); return guildsRepo; };
const ticketService = require(path.join(root, 'src/services/ticketService'));
const { ChannelType, PermissionFlagsBits } = require(path.join(root, 'node_modules', 'discord.js'));

const CAT = '100000000000000001', LOG = '100000000000000003', ROLE = '100000000000000004';
const channels = new Map();
function msgs(list) { const m = new Map(list.map((x, i) => [String(i), x])); return { fetch: async () => ({ values: () => m.values(), }) }; }
function makeChannel(id, props) {
  const c = { id, type: ChannelType.GuildText, deleted: false, sent: [], isTextBased: () => true,
    messages: msgs([{ createdTimestamp: Date.now(), author: { tag: 'alice#0001', id: '5' }, content: 'help', attachments: new Map(), embeds: [] }]),
    send: async (p) => { c.sent.push(p); return p; },
    delete: async () => { c.deleted = true; channels.delete(id); }, ...props };
  channels.set(id, c); return c;
}
const guild = {
  id: '999', name: 'Test',
  roles: { everyone: { id: '999' }, cache: new Map([[ROLE, { id: ROLE }]]), fetch: async () => null },
  channels: {
    fetch: async (id) => channels.get(id) || (id === CAT ? { id: CAT, type: ChannelType.GuildCategory } : id === LOG ? makeChannel(LOG, {}) : null),
    create: async (opts) => { const c = makeChannel(String(900 + channels.size), { name: opts.name, parent: opts.parent, overwrites: opts.permissionOverwrites }); return c; },
  },
};
const client = { user: { id: '777' } };
const alice = { id: '5', tag: 'alice#0001', roles: { cache: new Map() }, permissions: { has: () => false } };
const staff = { id: '6', tag: 'staff#0002', roles: { cache: new Map([[ROLE, true]]) }, permissions: { has: () => false } };

(async () => {
  // Panel and setup prerequisites
  store.misc = { tickets: { categoryId: CAT, supportRoleId: ROLE, logChannelId: LOG, counter: 0, open: {} } };
  const hall = makeChannel('200', {});
  await ticketService.postPanel(guild, hall, { misc: store.misc });
  console.log('panel posted:', hall.sent.length === 1);

  // Open ticket as alice
  const interaction = { guild, user: { id: '5', tag: 'alice#0001' }, member: alice, channelId: '200',
    deferReply: async () => {}, editReply: async (p) => { interaction.final = p; }, reply: async () => {}, deferred: true, replied: false };
  const handled = await ticketService.handleComponent(client, { ...interaction, customId: 'ticket:open' });
  console.log('open handled:', handled, 'reply:', interaction.final && interaction.final.embeds[0].title);
  const openIds = Object.keys(store.misc.tickets.open);
  console.log('open tickets recorded:', openIds.length, 'counter:', store.misc.tickets.counter);
  const ticketChannel = channels.get(openIds[0]);
  console.log('channel name:', ticketChannel.name, 'parent:', ticketChannel.parent);
  console.log('everyone denied view:', ticketChannel.overwrites.some(o => o.id === '999' && o.deny.includes(PermissionFlagsBits.ViewChannel)));

  // Second press by alice returns existing channel
  interaction.final = null;
  await ticketService.handleComponent(client, { ...interaction, customId: 'ticket:open' });
  console.log('duplicate press returns existing:', interaction.final.embeds[0].title, 'still one ticket:', Object.keys(store.misc.tickets.open).length === 1);

  // Stranger cannot close
  const stranger = { id: '8', tag: 'bob#0003', roles: { cache: new Map() }, permissions: { has: () => false } };
  let replied = null;
  await ticketService.handleComponent(client, { guild, user: stranger.tag && { id: '8' }, member: stranger, channelId: ticketChannel.id, customId: 'ticket:close',
    reply: async (p) => { replied = p; } });
  console.log('stranger refused:', replied && replied.embeds[0].title);

  // Staff closes via confirm button; transcript goes to log, channel deleted
  let updated = null;
  await ticketService.handleComponent(client, { guild, user: { id: '6', tag: 'staff#0002' }, member: staff, channelId: ticketChannel.id, customId: 'ticket:confirm-close',
    deferUpdate: async () => {}, update: async () => {}, deferred: true, replied: false, editReply: async (p) => { updated = p; } });
  const logCh = channels.get(LOG);
  console.log('transcript posted to log:', logCh.sent.length === 1 && logCh.sent[0].files.length === 1);
  console.log('ticket channel deleted:', ticketChannel.deleted, 'open list empty:', Object.keys(store.misc.tickets.open).length === 0);
  console.log('no error reply:', updated === null);
})().catch((e) => { console.error('FLOW FAILED', e); process.exit(1); });
