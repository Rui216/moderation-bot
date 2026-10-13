'use strict';

/**
 * Bot statistics for administrators: uptime, latency, guild count, scheduler
 * state, and gateway reachability. No secret, token, or Worker URL is exposed.
 */

const { COLORS } = require('../../config/constants');
const { baseEmbed } = require('../../utils/embeds');
const healthService = require('../../services/healthService');
const taskService = require('../../services/taskService');
const rateLimitService = require('../../services/rateLimitService');
const loggingService = require('../../services/loggingService');
const registry = require('../../core/registry');
const { getGateway, repo } = require('../../db');
const { logger } = require('../../utils/logger');

const log = logger.child('command');

module.exports = {
  name: 'stats',
  aliases: ['botinfo', 'status'],
  description: 'Show bot statistics and infrastructure health.',
  usage: 'stats',
  examples: ['stats'],
  permission: 'admin',
  action: 'viewcases',
  slashOptions: [],

  async execute(ctx) {
    const payload = healthService.payload();
    const scheduler = taskService.status();
    const registryStats = registry.stats();

    let gatewayState = 'unavailable';
    let queue = null;
    try {
      const gateway = getGateway();
      const response = await gateway.health();
      gatewayState = response.ok ? 'reachable' : 'degraded';
      queue = response.tasks || null;
    } catch (error) {
      gatewayState = 'unreachable';
      log.debug('Gateway health probe failed', { code: error && error.code });
    }

    const config = await repo('guilds').getStats(ctx.guild.id).catch(() => null);

    await ctx.replyEmbed(baseEmbed({
      title: 'Bot Statistics',
      color: gatewayState === 'reachable' ? COLORS.success : COLORS.notice,
      fields: [
        { name: 'Uptime', value: `${Math.floor(payload.uptimeSeconds / 3600)}h ${Math.floor((payload.uptimeSeconds % 3600) / 60)}m`, inline: true },
        { name: 'Gateway Latency', value: `${ctx.client.ws.ping} ms`, inline: true },
        { name: 'Guilds', value: String(ctx.client.guilds.cache.size), inline: true },
        { name: 'Storage Gateway', value: gatewayState, inline: true },
        { name: 'Commands Loaded', value: `${registryStats.commands} (${registryStats.aliases} aliases)`, inline: true },
        { name: 'Scheduler', value: `${scheduler.running ? 'running' : 'stopped'} every ${Math.round(scheduler.intervalMs / 1000)}s`, inline: true },
        ...(queue ? [{ name: 'Task Queue', value: `pending ${queue.pending} | running ${queue.running} | failed ${queue.failed}`, inline: false }] : []),
        { name: 'This Server', value: config ? `cases ${config.cases} | warnings ${config.activeWarnings} | scheduled ${config.pendingTasks}` : 'unavailable', inline: false },
        { name: 'Log Queue', value: String(loggingService.pending()), inline: true },
        { name: 'Rate Limits', value: rateLimitService.settings().enabled ? `${rateLimitService.settings().maxCommands} commands / ${Math.round(rateLimitService.settings().windowMs / 1000)}s` : 'disabled', inline: true },
      ],
      footer: ctx.guild.name,
    }));
  },
};
