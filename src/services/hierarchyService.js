'use strict';

/**
 * Role hierarchy and target validation.
 *
 * Discord enforces hierarchy for role and nickname edits, but timeouts, kicks,
 * and bans only depend on the bot holding the right permission. This module
 * applies the same expectations everywhere so a moderator can never act on
 * someone above them, and the bot never attempts an action it is not allowed
 * to perform.
 *
 * Rules:
 *   1. The guild owner can never be actioned.
 *   2. A member cannot action themselves.
 *   3. A member cannot action the bot itself.
 *   4. A member cannot action anyone whose highest role is at or above theirs,
 *      unless they are the guild owner.
 *   5. The bot cannot action anyone whose highest role is at or above the
 *      bot's highest role.
 */

const { HierarchyError, UserError } = require('../utils/errors');

/** Position of a member's highest role. @returns {number} */
function highestPosition(member) {
  if (!member) return -1;
  if (member.roles?.highest?.position !== undefined) return member.roles.highest.position;
  if (member.roles?.cache?.size) {
    return Math.max(...member.roles.cache.map((role) => role.position));
  }
  return 0;
}

/**
 * Validate that `moderator` may act on `target`.
 *
 * @param {import('discord.js').GuildMember} moderator
 * @param {import('discord.js').GuildMember} target
 * @param {{allowSelf?: boolean, requireBotAbove?: boolean}} [options]
 * @throws {HierarchyError|UserError} when the action must be refused
 */
function assertCanActOn(moderator, target, options = {}) {
  if (!target) throw new UserError('That member is not in this server.', { code: 'TARGET_MISSING' });

  const guild = target.guild || (moderator && moderator.guild);
  const botMember = guild ? guild.members.me : null;

  if (target.id === guild?.ownerId) {
    throw new HierarchyError('The server owner cannot be actioned by the bot.', { code: 'TARGET_IS_OWNER' });
  }

  if (moderator && target.id === moderator.id && !options.allowSelf) {
    throw new HierarchyError('You cannot action yourself.', { code: 'TARGET_IS_SELF' });
  }

  if (botMember && target.id === botMember.id) {
    throw new HierarchyError('The bot cannot action itself.', { code: 'TARGET_IS_BOT' });
  }

  const isGuildOwner = moderator && guild && moderator.id === guild.ownerId;

  if (moderator && !isGuildOwner && highestPosition(moderator) <= highestPosition(target)) {
    throw new HierarchyError(
      'That member has a role equal to or higher than yours, so the action was refused.',
      { code: 'TARGET_ABOVE_MODERATOR' },
    );
  }

  if (options.requireBotAbove !== false && botMember && highestPosition(botMember) <= highestPosition(target)) {
    throw new HierarchyError(
      'That member has a role equal to or above the bot role. Move the bot role higher in the role list.',
      { code: 'TARGET_ABOVE_BOT' },
    );
  }
}

/**
 * Validate a role the bot is about to add or remove.
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').Role} role
 */
function assertCanManageRole(guild, role) {
  const botMember = guild.members.me;
  if (!botMember) throw new UserError('The bot is not present in this server.', { code: 'BOT_MISSING' });

  if (!botMember.permissions.has('ManageRoles')) {
    throw new HierarchyError('The bot needs the Manage Roles permission to do that.', { code: 'BOT_MISSING_PERMISSION' });
  }
  if (role.managed) {
    throw new UserError('That role is managed by an integration and cannot be assigned manually.', { code: 'ROLE_MANAGED' });
  }
  if (role.id === guild.id) {
    throw new UserError('The default role cannot be assigned or removed.', { code: 'ROLE_EVERYONE' });
  }
  if (role.position >= botMember.roles.highest.position) {
    throw new HierarchyError('That role is higher than the bot role and cannot be managed.', { code: 'ROLE_ABOVE_BOT' });
  }
}

/**
 * Validate that the bot itself can be timed out / kicked / banned by checking
 * the guild-level permission set.
 * @param {import('discord.js').Guild} guild
 * @param {string[]} permissions
 */
function assertBotPermissions(guild, permissions = []) {
  const botMember = guild.members.me;
  if (!botMember) throw new UserError('The bot is not present in this server.', { code: 'BOT_MISSING' });
  const missing = permissions.filter((permission) => !botMember.permissions.has(permission));
  if (missing.length > 0) {
    throw new HierarchyError(
      `The bot is missing required permissions: ${missing.join(', ')}.`,
      { code: 'BOT_MISSING_PERMISSION', details: { missing } },
    );
  }
}

/** Compare two role positions, returning true when a is strictly higher. */
function isHigherThan(a, b) {
  return highestPosition(a) > highestPosition(b);
}

module.exports = {
  assertCanActOn,
  assertCanManageRole,
  assertBotPermissions,
  highestPosition,
  isHigherThan,
};
