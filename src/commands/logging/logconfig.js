'use strict';

/**
 * View and change logging behaviour at the individual event level.
 *
 *   logconfig                                  overview of every event and channel
 *   logconfig list [category]                  list events in a category
 *   logconfig enable <event ...>               turn events on
 *   logconfig disable <event ...>              turn events off
 *   logconfig channel <event> <#channel|none>  route one event to a channel
 *   logconfig slot <slot> <#channel|none>      set a default channel slot
 *   logconfig ignore <#channel>                stop logging events from a channel
 *   logconfig unignore <#channel>
 *
 * Event names accept the full key or a unique fragment, so "disable nickname"
 * resolves to member_nickname_update.
 */

const { COLORS, LOG_EVENTS, LOG_CATEGORIES, LOG_CHANNEL_SLOTS } = require('../../config/constants');
const { baseEmbed, successEmbed, emptyEmbed } = require('../../utils/embeds');
const { ValidationError } = require('../../utils/errors');
const { repo } = require('../../db');

/** Resolve a user supplied event name to one or more event keys. */
function resolveEvents(query) {
  const needle = String(query || '').toLowerCase().replace(/[\s-]/g, '_');
  if (!needle) return [];

  if (LOG_EVENTS[needle]) return [needle];

  const keys = Object.keys(LOG_EVENTS);
  const exact = keys.filter((key) => key === needle);
  if (exact.length > 0) return exact;

  const partial = keys.filter((key) => key.includes(needle) || LOG_EVENTS[key].label.toLowerCase().includes(needle.replace(/_/g, ' ')));
  return partial;
}

module.exports = {
  name: 'logconfig',
  aliases: ['logging', 'logs'],
  description: 'View or change which events are logged and where they are sent.',
  usage: 'logconfig [list|enable|disable|channel|slot|ignore|unignore] [arguments]',
  examples: [
    'logconfig',
    'logconfig disable member_nickname_update',
    'logconfig channel message_delete #message-logs',
    'logconfig slot modLog #mod-logs',
  ],
  permission: 'admin',
  action: null,
  slashOptions: [
    { name: 'action', type: 'string', required: false },
    { name: 'target', type: 'string', required: false },
    { name: 'channel', type: 'channel', required: false },
  ],

  async execute(ctx) {
    const action = (ctx.args[0] || 'show').toLowerCase();
    const logging = await repo('guilds').getLogging(ctx.guild.id, { force: true });

    switch (action) {
      case 'show':
      case 'view':
        await showOverview(ctx, logging);
        return;

      case 'list':
        await showCategory(ctx, logging, ctx.args[1]);
        return;

      case 'enable':
      case 'disable':
        await toggleEvents(ctx, logging, action, ctx.args.slice(1));
        return;

      case 'channel':
        await routeEvent(ctx, logging, ctx.args.slice(1));
        return;

      case 'slot':
        await setSlot(ctx, logging, ctx.args.slice(1));
        return;

      case 'ignore':
      case 'unignore':
        await toggleIgnore(ctx, logging, action, ctx.args.slice(1));
        return;

      default:
        throw new ValidationError(
          'Unknown option. Use show, list, enable, disable, channel, slot, ignore, or unignore.',
        );
    }
  },
};

/** Overview: one field per category listing events, state, and destination. */
async function showOverview(ctx, logging) {
  const fields = [];

  for (const [category, meta] of Object.entries(LOG_CATEGORIES)) {
    const entries = Object.entries(LOG_EVENTS).filter(([, event]) => event.category === category);
    if (entries.length === 0) continue;

    const lines = entries.map(([key, event]) => {
      const setting = (logging.events && logging.events[key]) || {};
      const state = setting.enabled ? 'on ' : 'off';
      const destination = setting.channelId
        ? `<#${setting.channelId}>`
        : `<#${logging.channels[event.defaultChannel] || 'unset'}>`;
      return `\`${state}\` ${key} -> ${logging.channels[event.defaultChannel] || setting.channelId ? destination : 'no channel'}`;
    });

    fields.push({ name: meta.label, value: lines.join('\n').slice(0, 1024), inline: false });
  }

  const slots = Object.entries(LOG_CHANNEL_SLOTS).map(([slot, meta]) => {
    const channelId = logging.channels[slot];
    return `${meta.label}: ${channelId ? `<#${channelId}>` : 'not set'}`;
  });

  fields.push({ name: 'Channel Slots', value: slots.join('\n'), inline: false });
  fields.push({
    name: 'Ignored Channels',
    value: logging.ignoreChannelIds && logging.ignoreChannelIds.length > 0
      ? logging.ignoreChannelIds.map((id) => `<#${id}>`).join(', ')
      : 'None',
    inline: false,
  });

  await ctx.replyEmbed(baseEmbed({
    title: `Log Configuration: ${ctx.guild.name}`,
    description: 'Each event can be toggled and routed independently. Change with logconfig enable, disable, channel, or slot.',
    color: COLORS.info,
    fields: fields.slice(0, 25),
    footer: `${ctx.guild.name} | logconfig`,
  }));
}

/** List events in one category, or every event when no category is given. */
async function showCategory(ctx, logging, categoryQuery) {
  const needle = String(categoryQuery || '').toLowerCase();

  const entries = Object.entries(LOG_EVENTS).filter(([, event]) => {
    if (!needle) return true;
    return event.category === needle || (LOG_CATEGORIES[event.category] || {}).label?.toLowerCase() === needle;
  });

  if (entries.length === 0) {
    await ctx.replyEmbed(emptyEmbed('No Matching Events', 'No log events match that category.'));
    return;
  }

  const fields = entries.map(([key, event]) => {
    const setting = (logging.events && logging.events[key]) || {};
    return {
      name: key,
      value: [
        event.description,
        `Category: ${event.category} | State: ${setting.enabled ? 'on' : 'off'}`,
        `Destination: ${setting.channelId ? `<#${setting.channelId}>` : `slot ${event.defaultChannel}`}`,
      ].join('\n'),
      inline: false,
    };
  });

  await ctx.replyEmbed(baseEmbed({
    title: 'Log Events',
    color: COLORS.info,
    fields: fields.slice(0, 25),
    footer: `${ctx.guild.name} | ${entries.length} events`,
  }));
}

/** Enable or disable one or more events. */
async function toggleEvents(ctx, logging, action, queries) {
  if (queries.length === 0) throw new ValidationError(`Provide at least one event name to ${action}.`);

  const enabled = action === 'enable';
  const resolved = [];
  const unknown = [];

  for (const query of queries) {
    const matches = resolveEvents(query);
    if (matches.length === 0) {
      unknown.push(query);
      continue;
    }
    resolved.push(...matches);
  }

  if (resolved.length === 0) {
    throw new ValidationError(`No log event matches: ${unknown.join(', ')}. Use the logconfig list option to see the event names.`);
  }

  const patch = {};
  for (const key of new Set(resolved)) {
    patch[key] = { ...(logging.events[key] || {}), enabled };
  }

  await repo('guilds').updateLogging(ctx.guild.id, { events: patch });

  const results = [...new Set(resolved)].map((key) => {
    const setting = patch[key];
    const channel = setting.channelId || logging.channels[LOG_EVENTS[key].defaultChannel];
    return `${key}: ${enabled ? 'enabled' : 'disabled'}${enabled && !channel ? ' (no channel assigned yet)' : ''}`;
  });

  await ctx.replyEmbed(successEmbed({
    title: enabled ? 'Log Events Enabled' : 'Log Events Disabled',
    color: COLORS.success,
    description: results.join('\n').slice(0, 4000),
    fields: [
      { name: 'Changed By', value: `<@${ctx.author.id}>`, inline: true },
      ...(unknown.length > 0 ? [{ name: 'Not Recognized', value: unknown.join(', '), inline: true }] : []),
    ],
    footer: ctx.guild.name,
  }));
}

/** Route one event to a specific channel or back to its default slot. */
async function routeEvent(ctx, logging, tokens) {
  const eventQuery = tokens[0];
  const channelQuery = tokens[1];
  if (!eventQuery || !channelQuery) {
    throw new ValidationError('Usage: logconfig channel <event> <#channel or none>');
  }

  const matches = resolveEvents(eventQuery);
  if (matches.length === 0) throw new ValidationError(`No log event matches "${eventQuery}".`);

  let channelId = null;
  if (!['none', 'off', 'default', 'clear'].includes(channelQuery.toLowerCase())) {
    const channel = await ctx.resolveChannel(channelQuery);
    if (!channel) throw new ValidationError('That channel could not be found.');
    channelId = channel.id;
  }

  const patch = {};
  for (const key of matches) {
    patch[key] = { ...(logging.events[key] || {}), channelId };
  }
  await repo('guilds').updateLogging(ctx.guild.id, { events: patch });

  await ctx.replyEmbed(successEmbed({
    title: 'Log Destination Updated',
    color: COLORS.success,
    description: matches
      .map((key) => `${key} -> ${channelId ? `<#${channelId}>` : `default slot (${LOG_EVENTS[key].defaultChannel})`}`)
      .join('\n'),
    footer: ctx.guild.name,
  }));
}

/** Set a default channel slot. */
async function setSlot(ctx, logging, tokens) {
  const slotQuery = String(tokens[0] || '').toLowerCase();
  const channelQuery = tokens[1];
  if (!slotQuery || !channelQuery) {
    throw new ValidationError(`Usage: logconfig slot <slot> <#channel or none>. Slots: ${Object.keys(LOG_CHANNEL_SLOTS).join(', ')}`);
  }

  const slot = Object.keys(LOG_CHANNEL_SLOTS).find((key) => key.toLowerCase() === slotQuery)
    || Object.keys(LOG_CHANNEL_SLOTS).find((key) => key.toLowerCase().includes(slotQuery));
  if (!slot) throw new ValidationError(`Unknown channel slot. Valid slots: ${Object.keys(LOG_CHANNEL_SLOTS).join(', ')}`);

  let channelId = null;
  if (!['none', 'off', 'clear'].includes(channelQuery.toLowerCase())) {
    const channel = await ctx.resolveChannel(channelQuery);
    if (!channel) throw new ValidationError('That channel could not be found.');
    channelId = channel.id;
  }

  await repo('guilds').updateLogging(ctx.guild.id, { channels: { [slot]: channelId } });

  await ctx.replyEmbed(successEmbed({
    title: 'Log Channel Updated',
    color: COLORS.success,
    description: `${LOG_CHANNEL_SLOTS[slot].label} slot -> ${channelId ? `<#${channelId}>` : 'cleared'}`,
    fields: [{
      name: 'Events Using This Slot',
      value: Object.entries(LOG_EVENTS)
        .filter(([, meta]) => meta.defaultChannel === slot)
        .map(([key]) => key)
        .join(', ') || 'None',
      inline: false,
    }],
    footer: ctx.guild.name,
  }));
}

/** Add or remove a channel from the ignore list. */
async function toggleIgnore(ctx, logging, action, tokens) {
  const query = tokens[0];
  if (!query) throw new ValidationError('Provide a channel to ignore or unignore.');

  const channel = await ctx.resolveChannel(query);
  if (!channel) throw new ValidationError('That channel could not be found.');

  const current = new Set(logging.ignoreChannelIds || []);
  if (action === 'ignore') current.add(channel.id);
  else current.delete(channel.id);

  await repo('guilds').updateLogging(ctx.guild.id, { ignoreChannelIds: [...current] });

  await ctx.replyEmbed(successEmbed({
    title: action === 'ignore' ? 'Channel Ignored' : 'Channel Unignored',
    color: COLORS.success,
    description: action === 'ignore'
      ? `<#${channel.id}> will no longer appear in message logs.`
      : `<#${channel.id}> is logged again.`,
    fields: [{
      name: 'Ignored Channels',
      value: [...current].map((id) => `<#${id}>`).join(', ') || 'None',
      inline: false,
    }],
    footer: ctx.guild.name,
  }));
}
