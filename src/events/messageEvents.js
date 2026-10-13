'use strict';

/**
 * Message logging: deletions (with audit attribution), bulk deletions, and
 * edits. Each event has its own toggle in the logging configuration.
 *
 * Attribution note: Discord only writes a MessageDelete audit entry when a
 * member with Manage Messages removes a message. Self-deletions leave no trace,
 * and the log entry says so rather than guessing.
 */

const { AuditLogEvent } = require('discord.js');

const { cleanText } = require('../utils/sanitize');
const { repo } = require('../db');
const loggingService = require('../services/loggingService');
const { logger } = require('../utils/logger');

const log = logger.child('events');

function register(client) {
  client.on('messageDelete', (message) => {
    void handleDelete(client, message);
  });

  client.on('messageDeleteBulk', (messages, channel) => {
    void handleBulkDelete(client, messages, channel);
  });

  client.on('messageUpdate', (before, after) => {
    void handleUpdate(client, before, after);
  });
}

/** Load configuration once per event, ignoring failures. */
async function loadConfig(guildId) {
  try {
    return await repo('guilds').getConfig(guildId);
  } catch (error) {
    log.debug('Configuration unavailable for logging', { code: error && error.code });
    return null;
  }
}

async function handleDelete(client, message) {
  try {
    const guild = message.guild;
    if (!guild) return;

    const config = await loadConfig(guild.id);
    if (!config) return;

    // Partial messages carry no content; report what is known.
    const author = message.author || null;
    const content = message.content || '';

    const attribution = await loggingService.findMessageDeleteExecutor(guild, message.channelId);

    await loggingService.emit(guild, 'message_delete', {
      title: 'Message Deleted',
      description: content ? cleanText(content, 1500) : 'Content unavailable (message was not cached).',
      fields: [
        { name: 'Author', value: author ? `${author.tag} (${author.id})` : 'Unknown', inline: true },
        { name: 'Channel', value: `<#${message.channelId}>`, inline: true },
        {
          name: 'Removed By',
          value: attribution ? `${attribution.executorTag || 'Unknown'} (${attribution.executorId})` : 'Not attributable (self deletion or no audit entry)',
          inline: false,
        },
      ],
      footer: guild.name,
      sourceChannelId: message.channelId,
      loggingConfig: null,
    });
  } catch (error) {
    log.debug('Message delete log failed', { code: error && error.code });
  }
}

async function handleBulkDelete(client, messages, channel) {
  try {
    const guild = channel.guild;
    if (!guild) return;

    const config = await loadConfig(guild.id);
    if (!config) return;

    const attribution = await loggingService.findAuditEntry(guild, AuditLogEvent.MessageBulkDelete, { windowMs: 15000 });
    const authors = new Map();
    for (const message of messages.values()) {
      const key = message.author ? message.author.id : 'unknown';
      authors.set(key, (authors.get(key) || 0) + 1);
    }

    await loggingService.emit(guild, 'message_bulk_delete', {
      title: 'Bulk Message Deletion',
      description: `${messages.size} messages were removed.`,
      fields: [
        { name: 'Channel', value: `<#${channel.id}>`, inline: true },
        { name: 'Count', value: String(messages.size), inline: true },
        {
          name: 'Removed By',
          value: attribution ? `${attribution.executorTag || 'Unknown'} (${attribution.executorId})` : 'Unknown or performed by the bot',
          inline: false,
        },
        {
          name: 'Top Authors',
          value: [...authors.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([id, count]) => `${id === 'unknown' ? 'Unknown' : `<@${id}>`}: ${count}`)
            .join('\n') || 'Unknown',
          inline: false,
        },
      ],
      footer: guild.name,
      sourceChannelId: channel.id,
    });
  } catch (error) {
    log.debug('Bulk delete log failed', { code: error && error.code });
  }
}

async function handleUpdate(client, before, after) {
  try {
    const guild = after.guild || before.guild;
    if (!guild) return;

    if (!before.content && !after.content) return;
    if (before.content === after.content) return;

    const config = await loadConfig(guild.id);
    if (!config) return;

    await loggingService.emit(guild, 'message_edit', {
      title: 'Message Edited',
      description: `[Jump to message](${after.url || before.url || 'https://discord.com'})`,
      fields: [
        { name: 'Author', value: after.author ? `${after.author.tag} (${after.author.id})` : 'Unknown', inline: true },
        { name: 'Channel', value: `<#${after.channelId}>`, inline: true },
        { name: 'Before', value: cleanText(before.content, 1000) || 'Unknown', inline: false },
        { name: 'After', value: cleanText(after.content, 1000) || 'Unknown', inline: false },
      ],
      footer: guild.name,
      sourceChannelId: after.channelId,
    });
  } catch (error) {
    log.debug('Message edit log failed', { code: error && error.code });
  }
}

module.exports = { register };
