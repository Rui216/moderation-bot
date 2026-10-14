'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PermissionFlagsBits: P } = require('discord.js');
const { fixture, IDS } = require('./helpers/ticketFixture');
// Bind repo before loading services, which capture the repo function.
const initial = fixture();
const tickets = require('../src/services/ticketService');
const wizard = require('../src/core/ticketSetupWizard');
const command = require('../src/commands/tickets/ticketsetup');

// Reuse one fixture so the captured repository points at the same data store.
const f = initial;
function reset() {
  require('../src/services/rateLimitService').reset();
  for (const key of Object.keys(f.faults)) delete f.faults[key];
  f.state.misc.tickets = { categoryId: IDS.category, supportRoleId: IDS.role, logChannelId: IDS.log,
    panelChannelId: IDS.panel, open: {}, counter: 0 };
  f.repo.invalidate();
  f.log.sent.length = 0;
  f.panel.sent.length = 0;
  f.guild.ownerId = IDS.admin;
  for (const session of wizard.sessions.values()) wizard.destroy(session.id);
}
const open = (id = IDS.user) => tickets.openTicket(f.client, f.interaction('ticket:submit', id));
const close = (channel, id = IDS.staff) => tickets.closeTicket({ guild: f.guild, channel, closedBy: { id } });

test('Ticket regression suite', async (t) => {
  await t.test('panel and intake modal serialize to valid Discord payloads', async () => {
    reset();
    await tickets.postPanel(f.guild, f.panel, f.state);
    assert.equal(f.panel.sent[0].components[0].toJSON().components[0].custom_id, 'ticket:open');
    const i = f.interaction('ticket:open');
    assert.equal(await tickets.handleComponent(f.client, i), true);
    assert.equal(i.modal.toJSON().components.length, 2);
    assert.equal(Object.keys(f.state.misc.tickets.open).length, 0);
    const submit = f.interaction('ticket:submit');
    await tickets.handleComponent(f.client, submit);
    assert.equal(submit.response.embeds[0].title, 'Ticket Created');
  });
  await t.test('simultaneous opens produce one private ticket per member and unique numbers', async () => {
    reset();
    const [a, b, c] = await Promise.all([open(), open(), open(IDS.other)]);
    assert.equal(a.channel.id, b.channel.id);
    assert.equal(b.existing, true);
    assert.notEqual(a.channel.name, c.channel.name);
    assert.equal(Object.keys(f.state.misc.tickets.open).length, 2);
    assert.equal(f.state.misc.tickets.counter, 2);
    assert.deepEqual(f.state.misc.unrelated, { keep: true });
    assert(a.channel.overwrites.some((o) => o.id === IDS.guild && o.deny.includes(P.ViewChannel)));
    assert.equal(a.channel.overwrites.length, 4);
  });
  await t.test('stale tickets are cleaned; transient fetch failures do not erase state', async () => {
    reset();
    const { channel } = await open();
    f.faults.fetch = true;
    await assert.rejects(open(), /Discord unavailable/);
    assert(f.state.misc.tickets.open[channel.id]);
    f.faults.fetch = false;
    await channel.delete();
    await open();
    assert(!f.state.misc.tickets.open[channel.id]);
    assert.equal(Object.keys(f.state.misc.tickets.open).length, 1);
  });
  await t.test('unsafe support roles, invalid destinations, and missing permissions are rejected', async () => {
    reset();
    const settings = tickets.readSettings(f.state.misc);
    await assert.rejects(tickets.validateSetup(f.guild, { ...settings, supportRoleId: IDS.guild }), /staff role/);
    await assert.rejects(tickets.validateSetup(f.guild, { ...settings, logChannelId: IDS.category }), /text/);
    f.faults.permissions = true;
    await assert.rejects(open(), /permissions/);
    assert.equal(Object.keys(f.state.misc.tickets.open).length, 0);
  });
  await t.test('a storage failure rolls back the new channel; welcome failure keeps recoverable state', async () => {
    reset();
    const count = f.channels.size;
    f.faults.record = true;
    await assert.rejects(open(), /storage write/);
    assert.equal(f.channels.size, count);
    f.faults.record = false;
    f.faults.welcome = true;
    await assert.rejects(open(), /created at/);
    const existing = await open();
    assert.equal(existing.existing, true);
    assert(f.state.misc.tickets.open[existing.channel.id]);
  });
  await t.test('complete transcript paginates 250 messages chronologically', async () => {
    reset();
    const { channel } = await open();
    channel.history = Array.from({ length: 250 }, (_, i) => f.message(i + 1));
    const text = await tickets.buildTranscript(channel);
    assert.match(text, /Messages: 250/);
    assert(text.indexOf('message-1\n') < text.indexOf('message-250'));
    assert(text.includes('message-101\n'));
  });
  await t.test('transcript failure, upload failure, and delete failure all preserve the open ticket', async () => {
    reset();
    const { channel } = await open();
    for (const fault of ['history', 'upload', 'delete']) {
      f.faults[fault] = true;
      await assert.rejects(close(channel));
      assert.equal(channel.deleted, false);
      assert(f.state.misc.tickets.open[channel.id]);
      delete f.faults[fault];
    }
    assert.equal(f.log.sent.length, 1); // successful upload before the failed delete
    await close(channel);
    assert.equal(channel.deleted, true);
    assert.equal(Object.keys(f.state.misc.tickets.open).length, 0);
    assert.equal(f.log.sent.at(-1).files.length, 1);
  });
  await t.test('unauthorized close and missing log cannot destroy a ticket', async () => {
    reset();
    const { channel } = await open();
    await assert.rejects(close(channel, IDS.other), /Only the ticket owner/);
    f.state.misc.tickets.logChannelId = null;
    await assert.rejects(close(channel), /separate transcript/);
    assert.equal(channel.deleted, false);
  });
  await t.test('concurrent closes upload once and second attempt is safely rejected', async () => {
    reset();
    const { channel } = await open();
    const results = await Promise.allSettled([close(channel), close(channel)]);
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected']);
    assert.equal(f.log.sent.length, 1);
  });
  await t.test('close button has confirmation and cancellation controls', async () => {
    reset();
    const { channel } = await open();
    const i = f.interaction('ticket:close', IDS.user, channel.id);
    await tickets.handleComponent(f.client, i);
    assert.equal(i.response.components[0].toJSON().components.length, 2);
    assert.equal(channel.deleted, false);
    const cancel = f.interaction('ticket:cancel-close', IDS.user, channel.id);
    await tickets.handleComponent(f.client, cancel);
    assert.equal(cancel.response.components.length, 0);
    assert.equal(channel.deleted, false);
  });
  await t.test('partial slash setup updates the log channel, not the category', async () => {
    reset();
    const newLog = f.channel('300000000000000001');
    await command.execute({ guild: f.guild, args: ['', '', `<#${newLog.id}>`], replyEmbed: async () => {} });
    assert.equal(f.state.misc.tickets.logChannelId, newLog.id);
    assert.equal(f.state.misc.tickets.categoryId, IDS.category);
  });
  await t.test('wizard preview, modal, save/publish, ownership, and state preservation', async () => {
    reset();
    const i = f.interaction('', IDS.admin);
    const session = await wizard.start({ guild: f.guild, author: i.user, channel: f.panel, isSlash: true, interaction: i });
    assert.equal(i.response.components.length, 5);
    for (const row of i.response.components) row.toJSON();
    const action = (name, user = IDS.admin) => {
      const next = f.interaction(`ticketsetup:${session.id}:${name}`, user);
      next.message = { id: session.messageId };
      return next;
    };
    const stranger = action('save', IDS.other);
    await wizard.handleComponent(f.client, stranger);
    assert.match(stranger.response.embeds[0].description, /Only the administrator/);
    const preview = action('preview');
    await wizard.handleComponent(f.client, preview);
    assert.equal(preview.followups[0].embeds[0].title, 'Support Tickets');
    assert.equal(f.panel.sent.length, 0);
    const text = action('text');
    await wizard.handleComponent(f.client, text);
    assert.equal(text.modal.toJSON().title, 'Ticket panel text');
    const submit = action('text-submit');
    submit.fields = { getTextInputValue: (key) => key === 'title' ? 'Contact our team' : 'Tell us how we can help.' };
    await wizard.handleComponent(f.client, submit);
    assert.equal(f.state.misc.tickets.panelTitle, undefined);
    const { channel } = await open(); // created while wizard was open
    const publish = action('publish');
    await wizard.handleComponent(f.client, publish);
    assert.equal(publish.response.embeds[0].title, 'Ticket Setup Saved');
    assert(f.state.misc.tickets.open[channel.id]);
    assert.equal(f.state.misc.tickets.counter, 1);
    assert.equal(f.panel.sent[0].embeds[0].title, 'Contact our team');
    assert(!wizard.sessions.has(session.id));
    const expired = action('save');
    await wizard.handleComponent(f.client, expired);
    assert.match(expired.response.embeds[0].description, /expired/);
  });
  await t.test('wizard rechecks permissions before saving and cancel does not save', async () => {
    reset();
    const i = f.interaction('', IDS.admin);
    const session = await wizard.start({ guild: f.guild, author: i.user, channel: f.panel, isSlash: true, interaction: i });
    session.draft.panelTitle = 'Unsaved changes';
    f.guild.ownerId = IDS.other;
    const save = f.interaction(`ticketsetup:${session.id}:save`, IDS.admin);
    await wizard.handleComponent(f.client, save);
    assert.match(save.followups[0].embeds[0].description, /no longer/);
    assert.equal(f.state.misc.tickets.panelTitle, undefined);
    f.guild.ownerId = IDS.admin;
    const cancel = f.interaction(`ticketsetup:${session.id}:cancel`, IDS.admin);
    await wizard.handleComponent(f.client, cancel);
    assert.equal(f.state.misc.tickets.panelTitle, undefined);
    assert(!wizard.sessions.has(session.id));
  });
  reset();
});
