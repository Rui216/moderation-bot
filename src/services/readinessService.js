'use strict';

/**
 * Readiness checks shared by /doctor and the setup wizard summary.
 *
 * Everything here is read-only. Each check returns a status:
 *   ok    - works as configured
 *   warn  - works, but something is missing or will degrade
 *   fail  - the feature cannot work until the problem is fixed
 *
 * Inputs are plain values (a guild, the bot member, and a settings object),
 * so the wizard can check the choices made in-session before anything is saved.
 */

const { PermissionFlagsBits } = require('discord.js');

/** Each group lists the bot permissions its commands need. */
const PERMISSION_GROUPS = [
  { name: 'Moderation (kick, ban, tempban, softban, unban, mute, tempmute)', needs: ['KickMembers', 'BanMembers', 'ModerateMembers'] },
  { name: 'Roles (addrole, removerole, temprole, forcenick, nicklock)', needs: ['ManageRoles', 'ManageNicknames'] },
  { name: 'Channels (purge, slowmode, lockdown, unlock)', needs: ['ManageChannels', 'ManageMessages'] },
  { name: 'Automod (delete messages, mute, strikes)', needs: ['ManageMessages', 'ModerateMembers'] },
  { name: 'Tickets (ticketpanel, ticketclose)', needs: ['ManageChannels', 'ManageMessages'] },
  { name: 'Logs and info (modlog, serverinfo, whois, stats)', needs: ['ViewAuditLog', 'EmbedLinks'] },
];

/** Names of log slots that map to a channel in logging config. */
const LOG_SLOT_LABELS = {
  modLog: 'Mod log',
  messageLog: 'Message log',
  joinLeaveLog: 'Join/leave log',
  voiceLog: 'Voice log',
  serverLog: 'Server log',
  automodLog: 'Automod log',
};

/** Return the permission names in `needs` that the bot member lacks. */
function missingPermissions(me, needs) {
  if (!me) return [...needs];
  return needs.filter((name) => {
    const flag = PermissionFlagsBits[name];
    return !flag || !me.permissions.has(flag);
  });
}

/** Permission readiness per command group. */
function permissionGroupChecks(me) {
  return PERMISSION_GROUPS.map((group) => {
    if (!me) return { label: group.name, status: 'fail', detail: 'Bot member not found' };
    const missing = missingPermissions(me, group.needs);
    return missing.length === 0
      ? { label: group.name, status: 'ok', detail: 'Ready' }
      : { label: group.name, status: 'warn', detail: `Missing ${missing.join(', ')}` };
  });
}

/**
 * Whether the bot can post in a channel, including embeds.
 * @returns {{ok: boolean, missing: string[]}}
 */
function channelAccess(me, channel) {
  if (!me || !channel || typeof channel.permissionsFor !== 'function') {
    return { ok: false, missing: ['channel not found'] };
  }
  const perms = channel.permissionsFor(me);
  if (!perms) return { ok: false, missing: ['channel not visible'] };
  const missing = [];
  if (!perms.has(PermissionFlagsBits.ViewChannel)) missing.push('ViewChannel');
  if (!perms.has(PermissionFlagsBits.SendMessages)) missing.push('SendMessages');
  if (!perms.has(PermissionFlagsBits.EmbedLinks)) missing.push('EmbedLinks');
  return { ok: missing.length === 0, missing };
}

/**
 * Build the full set of readiness checks.
 *
 * @param {object} options
 * @param {import('discord.js').Guild} options.guild
 * @param {import('discord.js').GuildMember|null} options.me bot member
 * @param {object} options.settings
 * @param {Object<string,string>} [options.settings.logChannels] slot -> channel id
 * @param {boolean} [options.settings.muteRoleEnabled]
 * @param {string|null} [options.settings.mutedRoleId]
 * @param {boolean} [options.settings.appealsEnabled]
 * @param {string|null} [options.settings.appealsChannelId]
 * @param {string} [options.gatewayStatus] 'Reachable' | 'Not reachable' (doctor only)
 * @returns {Array<{label: string, status: 'ok'|'warn'|'fail', detail: string, group: string}>}
 */
function buildChecks({ guild, me, settings = {}, gatewayStatus = null }) {
  const checks = [];
  const add = (group, label, status, detail) => checks.push({ group, label, status, detail });

  // Connectivity and identity.
  if (gatewayStatus) {
    add('Setup', 'Storage gateway', gatewayStatus === 'Reachable' ? 'ok' : 'fail', gatewayStatus);
  }
  if (!me) {
    add('Setup', 'Bot member', 'fail', 'Bot member not found in this server');
  } else {
    const botRole = me.roles.botRole;
    add('Setup', 'Bot role', botRole ? 'ok' : 'warn', botRole ? 'Present' : 'Missing (re-invite the bot to create it)');
  }

  // Permissions.
  for (const check of permissionGroupChecks(me)) {
    add('Permissions', check.label, check.status, check.detail);
  }

  // Log channels that were chosen.
  const logChannels = settings.logChannels || {};
  for (const [slot, label] of Object.entries(LOG_SLOT_LABELS)) {
    const channelId = logChannels[slot];
    if (!channelId) continue;
    const channel = guild.channels.cache.get(channelId) || null;
    if (!channel) {
      add('Channels', label, 'fail', 'Selected channel no longer exists');
      continue;
    }
    const access = channelAccess(me, channel);
    add('Channels', label, access.ok ? 'ok' : 'warn',
      access.ok ? `<#${channelId}>` : `<#${channelId}> is missing ${access.missing.join(', ')}`);
  }

  // Mute role.
  if (settings.muteRoleEnabled && settings.mutedRoleId) {
    const role = guild.roles.cache.get(settings.mutedRoleId);
    add('Channels', 'Mute role', role ? 'ok' : 'fail', role ? `<@&${role.id}>` : 'Selected mute role no longer exists');
  }

  // Ban appeals.
  if (settings.appealsEnabled) {
    if (!settings.appealsChannelId) {
      add('Appeals', 'Appeals channel', 'fail', 'Appeals are on but no channel is selected');
    } else {
      const channel = guild.channels.cache.get(settings.appealsChannelId) || null;
      if (!channel) {
        add('Appeals', 'Appeals channel', 'fail', 'Selected channel no longer exists');
      } else {
        const access = channelAccess(me, channel);
        add('Appeals', 'Appeals channel', access.ok ? 'ok' : 'fail',
          access.ok ? `<#${channel.id}>` : `Bot is missing ${access.missing.join(', ')} in <#${channel.id}>`);
      }
    }
  } else {
    add('Appeals', 'Ban appeals', 'ok', 'Off (bans are not appealable through the bot)');
  }

  return checks;
}

/** Summarise checks into counts. */
function summarise(checks) {
  return {
    ok: checks.filter((check) => check.status === 'ok').length,
    warn: checks.filter((check) => check.status === 'warn').length,
    fail: checks.filter((check) => check.status === 'fail').length,
  };
}

/** Short text marker for a status, safe in any Discord client. */
function marker(status) {
  if (status === 'ok') return 'OK';
  if (status === 'warn') return 'Warning';
  return 'Problem';
}

/** Format checks as lines grouped by section. Returns a map of group -> lines. */
function formatGroups(checks) {
  const groups = {};
  for (const check of checks) {
    if (!groups[check.group]) groups[check.group] = [];
    groups[check.group].push(`${marker(check.status)}: ${check.label}${check.status === 'ok' && check.detail === 'Ready' ? '' : ` - ${check.detail}`}`);
  }
  return groups;
}

module.exports = {
  PERMISSION_GROUPS,
  buildChecks,
  channelAccess,
  summarise,
  formatGroups,
  marker,
};
