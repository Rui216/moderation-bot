'use strict';

/** Report gateway and round-trip latency. */

const { COLORS } = require('../../config/constants');
const { baseEmbed } = require('../../utils/embeds');
const healthService = require('../../services/healthService');
const taskService = require('../../services/taskService');
const { logger } = require('../../utils/logger');

const log = logger.child('command');

module.exports = {
  name: 'ping',
  aliases: ['latency'],
  description: 'Check the bot response time and gateway latency.',
  usage: 'ping',
  examples: ['ping'],
  permission: 'everyone',
  action: null,
  slashOptions: [],

  async execute(ctx) {
    const startedAt = Date.now();
    const before = ctx.isSlash ? null : await ctx.channel.send({ content: 'Measuring latency.' }).catch(() => null);
    const roundTrip = Date.now() - startedAt;

    const websocket = Number.isFinite(ctx.client.ws.ping) ? `${ctx.client.ws.ping} ms` : 'unknown';
    const enabled = healthService.payload();

    if (before) await before.delete().catch(() => null);

    await ctx.replyEmbed(baseEmbed({
      title: 'Latency Report',
      color: COLORS.info,
      fields: [
        { name: 'Round Trip', value: `${roundTrip} ms`, inline: true },
        { name: 'Gateway', value: websocket, inline: true },
        { name: 'Uptime', value: `${Math.floor(enabled.uptimeSeconds / 60)} minutes`, inline: true },
        { name: 'Scheduler', value: taskService.status().running ? 'running' : 'stopped', inline: true },
      ],
      footer: ctx.guild.name,
    }));

    log.debug('Ping command completed', { roundTrip });
  },
};
