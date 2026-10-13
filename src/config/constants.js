'use strict';

/**
 * Shared constants: embed palette, action metadata, log event registry,
 * punishment vocabulary, and other values reused across the codebase.
 *
 * Every embed produced by the bot is colored and titled from this file so the
 * output stays visually consistent no matter which command or event fired it.
 * Plain text only: no emoji exists anywhere in this project.
 */

/** Embed accent colors, grouped by severity/type. */
const COLORS = Object.freeze({
  // Destructive actions
  ban: 0xed4245,
  kick: 0xe67e22,
  mute: 0xe67e22,
  warn: 0xfee75c,
  // Reversals / positive outcomes
  success: 0x57f287,
  unban: 0x57f287,
  unmute: 0x57f287,
  // Information
  info: 0x5865f2,
  neutral: 0x4f545c,
  // Errors and notifications
  error: 0xed4245,
  notice: 0xfaa61a,
  // Logging
  logMod: 0xeb459e,
  logMessage: 0x5865f2,
  logMember: 0x57f287,
  logVoice: 0x1abc9c,
  logServer: 0xe67e22,
  logAutomod: 0xed4245,
});

/** Bounds enforced by Discord for embed strings (kept here to avoid magic numbers). */
const EMBED_LIMITS = Object.freeze({
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  authorName: 256,
  fields: 25,
  total: 6000,
});

/**
 * Punishments understood by automod and the escalation ladder.
 * "delete" and "none" only make sense for automod rules.
 */
const PUNISHMENTS = Object.freeze([
  'none',
  'delete',
  'warn',
  'mute',
  'tempmute',
  'kick',
  'ban',
  'tempban',
]);

/** Punishments that can be handed out by the escalation ladder. */
const ESCALATION_PUNISHMENTS = Object.freeze(['warn', 'mute', 'kick', 'ban']);

/** Automod rule keys. Order matters: rules are evaluated top to bottom. */
const AUTOMOD_RULES = Object.freeze(['invites', 'links', 'words', 'caps', 'mentions', 'emoji']);

/** Human readable labels for automod rules. */
const AUTOMOD_RULE_LABELS = Object.freeze({
  invites: 'Invite Links',
  links: 'External Links',
  words: 'Banned Words',
  caps: 'Excessive Caps',
  mentions: 'Mass Mentions',
  emoji: 'Emoji Spam',
});

/**
 * Action metadata used by the embed builder to produce consistent titles,
 * colors, and severity indicators across every moderation command.
 */
const ACTIONS = Object.freeze({
  ban: { title: 'Member Banned', color: COLORS.ban, severity: 'High', durationed: false },
  tempban: { title: 'Member Temporarily Banned', color: COLORS.ban, severity: 'High', durationed: true },
  unban: { title: 'Member Unbanned', color: COLORS.unban, severity: 'Medium', durationed: false },
  softban: { title: 'Member Softbanned', color: COLORS.ban, severity: 'High', durationed: false },
  kick: { title: 'Member Kicked', color: COLORS.kick, severity: 'Medium', durationed: false },
  mute: { title: 'Member Muted', color: COLORS.mute, severity: 'Medium', durationed: true },
  tempmute: { title: 'Member Temporarily Muted', color: COLORS.mute, severity: 'Medium', durationed: true },
  unmute: { title: 'Member Unmuted', color: COLORS.unmute, severity: 'Low', durationed: false },
  warn: { title: 'Member Warned', color: COLORS.warn, severity: 'Low', durationed: false },
  delwarn: { title: 'Warning Removed', color: COLORS.success, severity: 'Low', durationed: false },
  clearwarnings: { title: 'Warnings Cleared', color: COLORS.success, severity: 'Low', durationed: false },
  note: { title: 'Note Added', color: COLORS.info, severity: 'Info', durationed: false },
  purge: { title: 'Messages Purged', color: COLORS.info, severity: 'Medium', durationed: false },
  slowmode: { title: 'Slowmode Updated', color: COLORS.info, severity: 'Low', durationed: false },
  lockdown: { title: 'Channel Locked', color: COLORS.ban, severity: 'High', durationed: false },
  server_lockdown: { title: 'Server Locked', color: COLORS.ban, severity: 'Critical', durationed: false },
  unlock: { title: 'Channel Unlocked', color: COLORS.unmute, severity: 'Low', durationed: false },
  server_unlock: { title: 'Server Unlocked', color: COLORS.unmute, severity: 'Low', durationed: false },
  forcenick: { title: 'Nickname Updated', color: COLORS.info, severity: 'Low', durationed: false },
  nicklock: { title: 'Nickname Lock Updated', color: COLORS.info, severity: 'Low', durationed: false },
  addrole: { title: 'Role Added', color: COLORS.info, severity: 'Low', durationed: false },
  removerole: { title: 'Role Removed', color: COLORS.info, severity: 'Low', durationed: false },
  temprole: { title: 'Temporary Role Added', color: COLORS.info, severity: 'Low', durationed: true },
  automod: { title: 'Automod Action', color: COLORS.logAutomod, severity: 'Medium', durationed: false },
  raid: { title: 'Raid Protection Triggered', color: COLORS.ban, severity: 'Critical', durationed: false },
  expiry: { title: 'Punishment Expired', color: COLORS.success, severity: 'Info', durationed: false },
});

/**
 * Granular log event registry.
 *
 * Every loggable event has its own toggle and its own channel so a guild can,
 * for example, keep message-delete logs on while turning nickname-change logs
 * off, and route each event type to a different channel.
 *
 * Fields:
 *   category       - groups events in the logconfig command and the wizard
 *   defaultChannel - logical channel key used when the guild has not routed
 *                    the event to a specific channel
 *   defaultEnabled - initial state when a guild is first configured
 */
const LOG_EVENTS = Object.freeze({
  // Moderation
  mod_action: {
    label: 'Moderation Action',
    description: 'Kick, ban, mute, warn, and every other case-generating action',
    category: 'mod',
    defaultChannel: 'modLog',
    defaultEnabled: true,
  },
  case_update: {
    label: 'Case Updated',
    description: 'A case reason or note was edited after the fact',
    category: 'mod',
    defaultChannel: 'modLog',
    defaultEnabled: true,
  },
  automod_trigger: {
    label: 'Automod Triggered',
    description: 'A message was filtered by an automod rule',
    category: 'mod',
    defaultChannel: 'automodLog',
    defaultEnabled: true,
  },
  punishment_expired: {
    label: 'Punishment Expired',
    description: 'A temporary mute, ban, or role assignment expired',
    category: 'mod',
    defaultChannel: 'modLog',
    defaultEnabled: true,
  },

  // Messages
  message_delete: {
    label: 'Message Deleted',
    description: 'A single message was deleted, with author attribution',
    category: 'message',
    defaultChannel: 'messageLog',
    defaultEnabled: true,
  },
  message_edit: {
    label: 'Message Edited',
    description: 'A message was edited, showing the before and after content',
    category: 'message',
    defaultChannel: 'messageLog',
    defaultEnabled: true,
  },
  message_bulk_delete: {
    label: 'Messages Bulk Deleted',
    description: 'Multiple messages were removed at once (purge or manual bulk delete)',
    category: 'message',
    defaultChannel: 'messageLog',
    defaultEnabled: true,
  },

  // Members
  member_join: {
    label: 'Member Joined',
    description: 'A member joined, including an account-age warning for new accounts',
    category: 'member',
    defaultChannel: 'joinLeaveLog',
    defaultEnabled: true,
  },
  member_leave: {
    label: 'Member Left',
    description: 'A member left or was removed, with kick attribution when available',
    category: 'member',
    defaultChannel: 'joinLeaveLog',
    defaultEnabled: true,
  },
  member_ban: {
    label: 'Member Banned (external)',
    description: 'A ban applied outside the bot, detected through the audit log',
    category: 'member',
    defaultChannel: 'modLog',
    defaultEnabled: true,
  },
  member_unban: {
    label: 'Member Unbanned (external)',
    description: 'An unban applied outside the bot, detected through the audit log',
    category: 'member',
    defaultChannel: 'modLog',
    defaultEnabled: true,
  },
  member_nickname_update: {
    label: 'Nickname Changed',
    description: 'A member nickname was changed',
    category: 'member',
    defaultChannel: 'joinLeaveLog',
    defaultEnabled: false,
  },
  member_roles_update: {
    label: 'Member Roles Changed',
    description: 'Roles were added to or removed from a member',
    category: 'member',
    defaultChannel: 'serverLog',
    defaultEnabled: true,
  },

  // Voice
  voice_join: {
    label: 'Voice Channel Joined',
    description: 'A member joined a voice channel',
    category: 'voice',
    defaultChannel: 'voiceLog',
    defaultEnabled: true,
  },
  voice_leave: {
    label: 'Voice Channel Left',
    description: 'A member left a voice channel',
    category: 'voice',
    defaultChannel: 'voiceLog',
    defaultEnabled: true,
  },
  voice_move: {
    label: 'Voice Channel Moved',
    description: 'A member was moved between voice channels',
    category: 'voice',
    defaultChannel: 'voiceLog',
    defaultEnabled: true,
  },

  // Server structure
  channel_create: {
    label: 'Channel Created',
    description: 'A channel or category was created',
    category: 'server',
    defaultChannel: 'serverLog',
    defaultEnabled: true,
  },
  channel_delete: {
    label: 'Channel Deleted',
    description: 'A channel or category was deleted',
    category: 'server',
    defaultChannel: 'serverLog',
    defaultEnabled: true,
  },
  channel_update: {
    label: 'Channel Updated',
    description: 'Channel name, topic, slowmode, or permission overwrites changed',
    category: 'server',
    defaultChannel: 'serverLog',
    defaultEnabled: true,
  },
  role_create: {
    label: 'Role Created',
    description: 'A role was created',
    category: 'server',
    defaultChannel: 'serverLog',
    defaultEnabled: true,
  },
  role_delete: {
    label: 'Role Deleted',
    description: 'A role was deleted',
    category: 'server',
    defaultChannel: 'serverLog',
    defaultEnabled: true,
  },
  role_update: {
    label: 'Role Updated',
    description: 'Role permissions, color, or name changed',
    category: 'server',
    defaultChannel: 'serverLog',
    defaultEnabled: true,
  },
  guild_update: {
    label: 'Server Settings Changed',
    description: 'Server name, icon, verification level, or other guild settings changed',
    category: 'server',
    defaultChannel: 'serverLog',
    defaultEnabled: true,
  },
  invite_create: {
    label: 'Invite Created',
    description: 'A new invite was created for the server',
    category: 'server',
    defaultChannel: 'serverLog',
    defaultEnabled: false,
  },
  invite_delete: {
    label: 'Invite Deleted',
    description: 'An invite was deleted or expired',
    category: 'server',
    defaultChannel: 'serverLog',
    defaultEnabled: false,
  },
});

/** Categories used to group log events in the config surfaces. */
const LOG_CATEGORIES = Object.freeze({
  mod: { label: 'Moderation', color: COLORS.logMod },
  message: { label: 'Messages', color: COLORS.logMessage },
  member: { label: 'Members', color: COLORS.logMember },
  voice: { label: 'Voice', color: COLORS.logVoice },
  server: { label: 'Server', color: COLORS.logServer },
});

/**
 * Logical log channel slots. The setup wizard creates or assigns one real
 * Discord channel per slot; individual events can then be routed elsewhere.
 */
const LOG_CHANNEL_SLOTS = Object.freeze({
  modLog: { label: 'Mod Log', description: 'Moderation actions, cases, automod, expiries' },
  messageLog: { label: 'Message Log', description: 'Message edits, deletes, bulk deletes' },
  joinLeaveLog: { label: 'Join/Leave Log', description: 'Member joins, leaves, nicknames' },
  voiceLog: { label: 'Voice Log', description: 'Voice joins, leaves, moves' },
  serverLog: { label: 'Server Log', description: 'Channels, roles, invites, guild settings' },
  automodLog: { label: 'Automod Log', description: 'Filtered messages and raid protection alerts' },
});

/** Moderator permission levels, from most to least privileged. */
const PERMISSION_LEVELS = Object.freeze({
  OWNER: 'owner',
  ADMIN: 'admin',
  MODERATOR: 'moderator',
  TRUSTED: 'trusted',
  EVERYONE: 'everyone',
});

const LEVEL_WEIGHT = Object.freeze({
  owner: 100,
  admin: 80,
  moderator: 60,
  trusted: 40,
  everyone: 0,
});

/** Discord's maximum timeout length in milliseconds (28 days). */
const DISCORD_TIMEOUT_MAX_MS = 28 * 24 * 60 * 60 * 1000;

/** Duration parsing vocabulary: value -> milliseconds. */
const DURATION_UNITS = Object.freeze({
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60 * 1000,
  min: 60 * 1000,
  mins: 60 * 1000,
  minute: 60 * 1000,
  minutes: 60 * 1000,
  h: 60 * 60 * 1000,
  hr: 60 * 60 * 1000,
  hrs: 60 * 60 * 1000,
  hour: 60 * 60 * 1000,
  hours: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  weeks: 7 * 24 * 60 * 60 * 1000,
});

/** Case action names stored in the database. Kept explicit for validation. */
const CASE_ACTIONS = Object.freeze([
  'ban',
  'tempban',
  'unban',
  'softban',
  'kick',
  'mute',
  'tempmute',
  'unmute',
  'warn',
  'delwarn',
  'clearwarnings',
  'note',
  'purge',
  'slowmode',
  'lockdown',
  'server_lockdown',
  'unlock',
  'server_unlock',
  'forcenick',
  'nicklock',
  'addrole',
  'removerole',
  'temprole',
  'automod',
  'raid',
  'expiry',
]);

/** Scheduled task types handled by the task queue. */
const TASK_TYPES = Object.freeze({
  UNMUTE: 'unmute',
  UNBAN: 'unban',
  UNLOCK: 'unlock',
  UNLOCK_SERVER: 'unlock_server',
  REMOVE_ROLE: 'remove_role',
  EXPIRE_WARNINGS: 'expire_warnings',
});

/** Status values for scheduled tasks. */
const TASK_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

/** Generic user-facing strings that never leak internals. */
const MESSAGES = Object.freeze({
  genericError: 'Something went wrong while processing that request. The issue has been logged '
    + 'for the maintainers.',
  noPermission: 'You do not have permission to use that command.',
  hierarchy: 'That action cannot be completed because of role hierarchy.',
  notConfigurable: 'This server has not been configured yet. An administrator can run the '
    + 'setup command to get started.',
});

module.exports = {
  COLORS,
  EMBED_LIMITS,
  ACTIONS,
  PUNISHMENTS,
  ESCALATION_PUNISHMENTS,
  AUTOMOD_RULES,
  AUTOMOD_RULE_LABELS,
  LOG_EVENTS,
  LOG_CATEGORIES,
  LOG_CHANNEL_SLOTS,
  PERMISSION_LEVELS,
  LEVEL_WEIGHT,
  DISCORD_TIMEOUT_MAX_MS,
  DURATION_UNITS,
  CASE_ACTIONS,
  TASK_TYPES,
  TASK_STATUS,
  MESSAGES,
};
