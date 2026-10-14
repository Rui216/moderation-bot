'use strict';
const { ChannelType, Collection } = require('discord.js');
const guildRepo = require('../../src/db/repositories/guildRepository');
const IDS = { guild: '100000000000000000', category: '100000000000000001', role: '100000000000000002',
  log: '100000000000000003', panel: '100000000000000004', user: '100000000000000005', staff: '100000000000000006',
  other: '100000000000000007', bot: '100000000000000008', admin: '100000000000000009' };

function fixture() {
  const state = { misc: { unrelated: { keep: true }, tickets: { categoryId: IDS.category, supportRoleId: IDS.role,
    logChannelId: IDS.log, panelChannelId: IDS.panel, counter: 0, open: {} } }, adminRoleIds: [], requireReason: false };
  const faults = {};
  const channels = new Collection();
  let nextId = 200000000000000000n;
  const clone = (x) => structuredClone(x);
  guildRepo.invalidate();
  guildRepo.attach({
    async getGuildConfig() { if (faults.read) throw new Error('storage read failed'); return clone(state); },
    async updateGuildConfig(_id, patch) {
      if (faults.write || (faults.record && Object.keys(patch.misc?.tickets?.open || {}).length)) throw new Error('storage write failed');
      Object.assign(state, clone(patch));
      return clone(state);
    },
  });
  const db = require('../../src/db');
  db.repo = (name) => { if (name === 'guilds') return guildRepo; throw new Error(`Unexpected repo ${name}`); };
  function message(id, content = `message-${id}`) {
    return { id: String(id), createdTimestamp: Number(id) + 1700000000000, content,
      author: { id: IDS.user, tag: 'alice' }, attachments: new Collection(), embeds: [] };
  }
  function channel(id, options = {}) {
    const c = { id, type: ChannelType.GuildText, name: `channel-${id}`, sent: [], history: [message(1)], deleted: false,
      isTextBased: () => true, isThread: () => false, permissionsFor: () => ({ has: () => !faults.permissions }),
      messages: { fetch: async ({ before, limit }) => {
        if (faults.history) throw new Error('cannot read history');
        return new Collection(c.history.filter((m) => !before || BigInt(m.id) < BigInt(before))
          .sort((a, b) => Number(BigInt(b.id) - BigInt(a.id))).slice(0, limit).map((m) => [m.id, m]));
      } },
      send: async (payload) => {
        if ((id === IDS.log && faults.upload) || (id !== IDS.log && id !== IDS.panel && faults.welcome)
          || (id === IDS.panel && faults.panel)) throw new Error('cannot send');
        c.sent.push(payload);
        return { id: String(nextId++), edit: async (body) => { c.edited = body; } };
      },
      delete: async () => { if (faults.delete) throw new Error('cannot delete'); c.deleted = true; channels.delete(id); },
      ...options,
    };
    channels.set(id, c);
    return c;
  }
  const guild = { id: IDS.guild, name: 'Test server', ownerId: IDS.admin,
    roles: { everyone: { id: IDS.guild }, fetch: async (id) => id === IDS.role ? { id, managed: false } : id === IDS.guild ? { id } : null },
    channels: { cache: channels, fetch: async (id) => {
      if (faults.fetch) throw new Error('Discord unavailable');
      return channels.get(id) || null;
    }, create: async (options) => channel(String(nextId++), { ...options, overwrites: options.permissionOverwrites }) },
  };
  const member = (id, staff = false) => ({ id, guild, user: { id, tag: id }, roles: { cache: new Collection(staff ? [[IDS.role, {}]] : []) },
    permissions: { has: () => false } });
  const members = new Collection([[IDS.user, member(IDS.user)], [IDS.staff, member(IDS.staff, true)],
    [IDS.other, member(IDS.other)], [IDS.admin, member(IDS.admin)], [IDS.bot, member(IDS.bot)]]);
  guild.members = { me: members.get(IDS.bot), fetch: async (id) => members.get(id), fetchMe: async () => members.get(IDS.bot) };
  const client = { user: { id: IDS.bot } };
  channel(IDS.category, { type: ChannelType.GuildCategory });
  const panel = channel(IDS.panel);
  const log = channel(IDS.log);
  function interaction(customId, userId = IDS.user, channelId = IDS.panel) {
    const i = { customId, guild, guildId: IDS.guild, user: { id: userId, tag: userId }, member: members.get(userId), channelId,
      deferred: false, replied: false, followups: [],
      reply: async (body) => { i.replied = true; i.response = body; },
      editReply: async (body) => { i.replied = true; i.response = body; return { id: i.message?.id || 'setup-message' }; },
      followUp: async (body) => { i.followups.push(body); },
      deferReply: async () => { i.deferred = true; }, deferUpdate: async () => { i.deferred = true; },
      update: async (body) => { i.replied = true; i.response = body; },
      showModal: async (body) => { i.replied = true; i.modal = body; },
      fields: { getTextInputValue: (field) => field === 'subject' ? 'Need support' : 'Please help me with my account.' },
    };
    return i;
  }
  return { state, faults, guild, channels, members, client, channel, panel, log, message, interaction, repo: guildRepo };
}
module.exports = { fixture, IDS };
