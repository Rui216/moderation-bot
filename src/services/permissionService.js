'use strict';

/**
 * Permission resolution.
 *
 * The bot has its own authorization model on top of Discord permissions so a
 * server can delegate moderation to specific roles without granting
 * Administrator. Levels, from highest to lowest:
 *
 *   owner      - the guild owner, or a user listed in BOT_OWNER_IDS
 *   admin      - Discord Administrator, or a role in the guild's admin roles
 *   moderator  - a role in the guild's moderator roles
 *   trusted    - a role in the guild's trusted roles (light staffing duties)
 *   everyone   - anyone else
 *
 * Commands declare the minimum level required. A member's level is computed
 * once per invocation and cached for the duration of that invocation only.
 */

const { PERMISSION_LEVELS, LEVEL_WEIGHT } = require('../config/constants');

/** Discord permissions each moderation action needs from the bot itself. */
const REQUIRED_BOT_PERMISSIONS = Object.freeze({
  ban: ['BanMembers'],
  unban: ['BanMembers'],
  softban: ['BanMembers', 'ManageMessages'],
  kick: ['KickMembers'],
  mute: ['ModerateMembers'],
  unmute: ['ModerateMembers'],
  warn: [],
  purge: ['ManageMessages', 'ReadMessageHistory'],
  slowmode: ['ManageChannels'],
  lockdown: ['ManageChannels'],
  unlock: ['ManageChannels'],
  forcenick: ['ManageNicknames'],
  addrole: ['ManageRoles'],
  removerole: ['ManageRoles'],
  temprole: ['ManageRoles'],
  setup: ['ManageGuild'],
  config: ['ManageGuild'],
  logconfig: ['ManageGuild'],
  viewcases: [],
});

/**
 * Determine the effective permission level of a member in a guild.
 *
 * @param {import('discord.js').GuildMember|import('discord.js').Guild} memberOrGuild
 * @param {object} config guild configuration document
 * @param {string[]} [ownerIds] ids from BOT_OWNER_IDS
 * @returns {{level: string, weight: number, source: string}}
 */
function resolveLevel(member, config, ownerIds = []) {
  if (!member || !member.guild) {
    return { level: PERMISSION_LEVELS.EVERYONE, weight: LEVEL_WEIGHT.everyone, source: 'none' };
  }

  const guild = member.guild;
  const userId = member.id || member.user?.id;

  if (guild.ownerId === userId) {
    return { level: PERMISSION_LEVELS.OWNER, weight: LEVEL_WEIGHT.owner, source: 'guild-owner' };
  }

  if (Array.isArray(ownerIds) && ownerIds.includes(userId)) {
    return { level: PERMISSION_LEVELS.OWNER, weight: LEVEL_WEIGHT.owner, source: 'bot-owner' };
  }

  const roleIds = member.roles?.cache ? [...member.roles.cache.keys()] : [];

  if (member.permissions?.has?.('Administrator')) {
    return { level: PERMISSION_LEVELS.ADMIN, weight: LEVEL_WEIGHT.admin, source: 'discord-administrator' };
  }

  if (config) {
    const adminRoles = config.adminRoleIds || [];
    if (roleIds.some((roleId) => adminRoles.includes(roleId))) {
      return { level: PERMISSION_LEVELS.ADMIN, weight: LEVEL_WEIGHT.admin, source: 'admin-role' };
    }

    const modRoles = config.modRoleIds || [];
    if (roleIds.some((roleId) => modRoles.includes(roleId))) {
      return { level: PERMISSION_LEVELS.MODERATOR, weight: LEVEL_WEIGHT.moderator, source: 'moderator-role' };
    }

    const trustedRoles = config.trustedRoleIds || [];
    if (roleIds.some((roleId) => trustedRoles.includes(roleId))) {
      return { level: PERMISSION_LEVELS.TRUSTED, weight: LEVEL_WEIGHT.trusted, source: 'trusted-role' };
    }
  }

  return { level: PERMISSION_LEVELS.EVERYONE, weight: LEVEL_WEIGHT.everyone, source: 'everyone' };
}

/**
 * Check whether a member may run a command.
 *
 * @param {object} options
 * @param {import('discord.js').GuildMember} options.member
 * @param {object} options.config
 * @param {object} options.command command definition (uses command.permission)
 * @param {string[]} [options.ownerIds]
 * @returns {{allowed: boolean, level: string, weight: number, reason?: string}}
 */
function canRunCommand({ member, config, command, ownerIds = [] }) {
  const required = command.permission || PERMISSION_LEVELS.MODERATOR;
  const requiredWeight = LEVEL_WEIGHT[required] ?? LEVEL_WEIGHT.moderator;
  const resolved = resolveLevel(member, config, ownerIds);

  if (resolved.weight >= requiredWeight) {
    return { allowed: true, ...resolved };
  }
  return { allowed: false, ...resolved, reason: `Requires ${required} level or higher` };
}

/**
 * Check the bot's own Discord permissions for an action.
 * @param {import('discord.js').Guild} guild
 * @param {string} actionKey
 * @returns {{allowed: boolean, missing: string[]}}
 */
function checkBotPermissions(guild, actionKey) {
  const required = REQUIRED_BOT_PERMISSIONS[actionKey] || [];
  const me = guild.members.me;
  if (!me) return { allowed: false, missing: required };

  const missing = required.filter((permission) => !me.permissions.has(permission));
  return { allowed: missing.length === 0, missing };
}

/** Human readable level label for embeds. */
function levelLabel(level) {
  const labels = {
    owner: 'Owner',
    admin: 'Administrator',
    moderator: 'Moderator',
    trusted: 'Trusted',
    everyone: 'Member',
  };
  return labels[level] || 'Member';
}

/** True when the member holds any of the configured roles. */
function hasAnyRole(member, roleIds) {
  if (!member || !Array.isArray(roleIds) || roleIds.length === 0) return false;
  if (!member.roles?.cache) return false;
  return roleIds.some((roleId) => member.roles.cache.has(roleId));
}

/** True when the member is staff (trusted level or above). */
function isStaff(member, config, ownerIds = []) {
  return resolveLevel(member, config, ownerIds).weight >= LEVEL_WEIGHT.trusted;
}

module.exports = {
  resolveLevel,
  canRunCommand,
  checkBotPermissions,
  levelLabel,
  hasAnyRole,
  isStaff,
  REQUIRED_BOT_PERMISSIONS,
};
