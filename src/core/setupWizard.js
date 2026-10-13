'use strict';

/**
 * Interactive setup wizard.
 *
 * A session-based state machine driven by buttons, select menus, and typed
 * replies. The same engine serves both invocation styles:
 *   - prefix command:   the wizard posts in the channel and reads typed replies
 *   - slash command:    the wizard posts ephemerally and reads the same input
 *
 * Nothing is written to the database until the final confirmation screen is
 * accepted, so an abandoned wizard leaves no partial configuration behind.
 *
 * Sessions expire after a period of inactivity and are removed from memory.
 */

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');

const {
  COLORS,
  LOG_EVENTS,
  LOG_CATEGORIES,
  LOG_CHANNEL_SLOTS,
  AUTOMOD_RULES,
  AUTOMOD_RULE_LABELS,
} = require('../config/constants');
const { baseEmbed, successEmbed, errorEmbed } = require('../utils/embeds');
const { sanitizePrefix, clampInt } = require('../utils/sanitize');
const { logger } = require('../utils/logger');
const { repo } = require('../db');
const { defaultAutomodConfig, defaultLoggingConfig } = require('../config/defaults');

const log = logger.child('wizard');

/** Active sessions keyed by guild and user. */
const sessions = new Map();

/** Session lifetime in milliseconds. */
const SESSION_TTL_MS = 15 * 60 * 1000;

/** Automation presets offered during setup. */
const AUTOMOD_PRESETS = {
  recommended: {
    label: 'Recommended',
    description: 'Invites blocked, caps and mass mentions warned, link filter off',
    apply: (config) => {
      config.rules.invites = { ...config.rules.invites, enabled: true, punishment: 'delete' };
      config.rules.links = { ...config.rules.links, enabled: false, punishment: 'delete' };
      config.rules.words = { ...config.rules.words, enabled: false, punishment: 'delete' };
      config.rules.caps = { ...config.rules.caps, enabled: true, punishment: 'warn' };
      config.rules.mentions = { ...config.rules.mentions, enabled: true, punishment: 'warn' };
      config.rules.emoji = { ...config.rules.emoji, enabled: false, punishment: 'delete' };
      return config;
    },
  },
  strict: {
    label: 'Strict',
    description: 'Every rule enabled with delete or warn, escalation ladder on',
    apply: (config) => {
      for (const rule of AUTOMOD_RULES) {
        config.rules[rule] = {
          ...config.rules[rule],
          enabled: true,
          punishment: rule === 'caps' || rule === 'mentions' ? 'warn' : 'delete',
        };
      }
      config.escalation = { ...config.escalation, enabled: true };
      return config;
    },
  },
  minimal: {
    label: 'Minimal',
    description: 'Only invite links blocked',
    apply: (config) => {
      for (const rule of AUTOMOD_RULES) {
        config.rules[rule] = { ...config.rules[rule], enabled: rule === 'invites' };
      }
      return config;
    },
  },
  skip: {
    label: 'Configure later',
    description: 'Leave automod at its defaults and use the automod command later',
    apply: (config) => config,
  },
};

/** Step definitions. Each step renders one screen. */
const STEPS = [
  'welcome',
  'prefix',
  'prefix_toggle',
  'admin_roles',
  'mod_roles',
  'trusted_roles',
  'mute_role',
  'log_mode',
  'log_slot',
  'log_events',
  'automod',
  'lockdown',
  'behaviour',
  'summary',
];

/** Ordered channel slots visited by the log_slot step. */
const SLOT_ORDER = ['modLog', 'messageLog', 'joinLeaveLog', 'voiceLog', 'serverLog', 'automodLog'];

/**
 * Start a new session, or resume the existing one.
 *
 * @param {object} options
 * @param {import('discord.js').Client} options.client
 * @param {import('discord.js').Guild} options.guild
 * @param {import('discord.js').GuildMember} options.member
 * @param {import('discord.js').TextBasedChannel} options.channel
 * @param {import('discord.js').ChatInputCommandInteraction} [options.interaction]
 * @param {object} options.config current guild configuration
 */
async function start(options) {
  const key = sessionKey(options.guild.id, options.member.id);

  const existing = sessions.get(key);
  if (existing) destroy(key);

  const session = {
    key,
    client: options.client,
    guild: options.guild,
    member: options.member,
    channel: options.channel,
    interaction: options.interaction || null,
    stepIndex: 0,
    data: {
      prefix: options.config.prefix || options.client.appConfig.discord.defaultPrefix,
      prefixEnabled: options.config.prefixEnabled !== false,
      adminRoleIds: [...(options.config.adminRoleIds || [])],
      modRoleIds: [...(options.config.modRoleIds || [])],
      trustedRoleIds: [...(options.config.trustedRoleIds || [])],
      mutedRoleId: options.config.mutedRoleId || null,
      muteRoleEnabled: Boolean(options.config.muteRoleEnabled),
      createMuteRole: false,
      logMode: 'auto',
      logChannels: { ...(options.config.logChannels || {}) },
      logSlotIndex: 0,
      logAutoCreated: null,
      enabledEvents: null,
      automodPreset: 'recommended',
      lockdownRoleIds: [...((options.config.lockdown && options.config.lockdown.roleIds) || [])],
      autoUnlockMinutes: (options.config.lockdown && options.config.lockdown.autoUnlockMinutes) || 0,
      requireReason: options.config.requireReason !== false,
      dmOnPunishment: options.config.dmOnPunishment !== false,
    },
    awaitingText: null,
    messageId: null,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
    timeout: null,
  };

  sessions.set(key, session);
  scheduleExpiry(session);

  await render(session);
  return session;
}

function sessionKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

/** Schedule session expiry. */
function scheduleExpiry(session) {
  if (session.timeout) clearTimeout(session.timeout);
  session.timeout = setTimeout(() => {
    const active = sessions.get(session.key);
    if (!active) return;
    destroy(active.key);
    void notifyExpired(active);
  }, SESSION_TTL_MS);
  if (session.timeout.unref) session.timeout.unref();
}

/** Remove a session from memory. */
function destroy(key) {
  const session = sessions.get(key);
  if (!session) return;
  if (session.timeout) clearTimeout(session.timeout);
  sessions.delete(key);
}

/** Retrieve the session belonging to a user in a guild. */
function get(guildId, userId) {
  return sessions.get(sessionKey(guildId, userId)) || null;
}

/** True when any session is waiting for typed input from this user. */
function isAwaitingText(guildId, userId) {
  const session = get(guildId, userId);
  return Boolean(session && session.awaitingText);
}

async function notifyExpired(session) {
  const embed = errorEmbed({
    title: 'Setup Expired',
    description: 'The setup wizard closed because it was inactive for a while. Run the setup command again to continue.',
  });
  await sendToSession(session, embed).catch(() => null);
}

/**
 * Send or edit the session message.
 * @param {object} session
 * @param {object} payload { embeds, components }
 */
async function sendToSession(session, payload) {
  if (session.interaction) {
    if (payload.embeds) {
      const body = { embeds: payload.embeds, components: payload.components || [], flags: MessageFlags.Ephemeral };
      if (session.interaction.deferred || session.interaction.replied) {
        return session.interaction.editReply(body).catch(() => null);
      }
      return session.interaction.reply(body).catch(() => null);
    }
    return null;
  }

  if (session.messageId) {
    const message = await session.channel.messages.fetch(session.messageId).catch(() => null);
    if (message) {
      return message.edit(payload).catch(() => null);
    }
  }

  const sent = await session.channel.send(payload).catch(() => null);
  if (sent) session.messageId = sent.id;
  return sent;
}

/** Build the embed and components for the current step. */
function renderStep(session) {
  const step = STEPS[session.stepIndex] || 'summary';

  switch (step) {
    case 'welcome':
      return {
        embed: baseEmbed({
          title: `Setup Wizard: ${session.guild.name}`,
          description: [
            'This wizard configures moderation for this server. Nothing is saved until you confirm on the final screen.',
            '',
            'Steps:',
            '1. Command prefix and prefix command availability',
            '2. Administrator, moderator, and trusted roles',
            '3. Mute role (optional, uses Discord native timeout by default)',
            '4. Log channels, created automatically or selected',
            '5. Which log event types are enabled',
            '6. Automod rules with a starting preset',
            '7. Lockdown defaults',
            '8. Reason requirement and direct message notifications',
            '',
            'You can re-run this wizard at any time, and the config command shows the current settings.',
          ].join('\n'),
          color: COLORS.info,
          footer: `${session.guild.name} | Step 1 of ${STEPS.length}`,
        }),
        components: [row(
          new ButtonBuilder().setCustomId('setup:next').setLabel('Begin').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('setup:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        )],
      };

    case 'prefix':
      return {
        embed: baseEmbed({
          title: 'Command Prefix',
          description: session.awaitingText
            ? 'Type the new prefix in this channel. Use up to 5 characters, no spaces.'
            : `Current prefix: \`${session.data.prefix}\`\n\nPress Change to type a new prefix, or Continue to keep it.`,
          color: COLORS.info,
          fields: [
            { name: 'Current', value: `\`${session.data.prefix}\``, inline: true },
            { name: 'Commands Enabled', value: session.data.prefixEnabled ? 'yes' : 'no', inline: true },
          ],
          footer: `${session.guild.name} | Step 2 of ${STEPS.length}`,
        }),
        components: [row(
          new ButtonBuilder().setCustomId('setup:prefix:change').setLabel('Change Prefix').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('setup:next').setLabel('Continue').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('setup:back').setLabel('Back').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('setup:cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger),
        )],
      };

    case 'prefix_toggle':
      return {
        embed: baseEmbed({
          title: 'Prefix Commands',
          description: [
            'Prefix commands are the primary interface for this bot.',
            'Disabling them makes the bot ignore every message command, which is only useful if you plan to use slash commands exclusively.',
            '',
            'Slash commands are an optional hybrid mode and require the bot to be invited with the applications.commands scope. Registering them can take up to an hour globally, which is why prefix commands remain the default.',
          ].join('\n'),
          color: COLORS.info,
          fields: [{ name: 'Current', value: session.data.prefixEnabled ? 'enabled' : 'disabled', inline: true }],
          footer: `${session.guild.name} | Step 3 of ${STEPS.length}`,
        }),
        components: [row(
          new ButtonBuilder()
            .setCustomId('setup:prefix:toggle')
            .setLabel(session.data.prefixEnabled ? 'Disable Prefix Commands' : 'Enable Prefix Commands')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('setup:next').setLabel('Continue').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('setup:back').setLabel('Back').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('setup:cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger),
        )],
      };

    case 'admin_roles':
    case 'mod_roles':
    case 'trusted_roles':
      return roleStep(session, step);

    case 'mute_role':
      return {
        embed: baseEmbed({
          title: 'Mute Role',
          description: [
            'Muting uses Discord native timeouts, which need no extra role and cannot be bypassed by channel permissions.',
            '',
            'Some servers still want a mute role: members holding it are denied Send Messages in the channels you choose. If you create one here, the bot applies that overwrite to every text channel.',
            '',
            session.data.createMuteRole
              ? 'A new mute role will be created and applied to all text channels.'
              : (session.data.mutedRoleId
                ? `Selected role: <@&${session.data.mutedRoleId}>`
                : 'No mute role. Native timeouts only.'),
          ].join('\n'),
          color: COLORS.info,
          footer: `${session.guild.name} | Step 6 of ${STEPS.length}`,
        }),
        components: [
          row(
            new ButtonBuilder().setCustomId('setup:mute:create').setLabel('Create Mute Role').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('setup:mute:none').setLabel('No Mute Role').setStyle(ButtonStyle.Secondary),
          ),
          row(
            new ButtonBuilder().setCustomId('setup:next').setLabel('Continue').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('setup:back').setLabel('Back').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setup:cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger),
          ),
        ],
      };

    case 'log_mode':
      return {
        embed: baseEmbed({
          title: 'Log Channels',
          description: [
            'The bot can create a private category with one channel per log type, or you can select existing channels.',
            '',
            'Created channels are hidden from members without a staff role, and each log event type can later be routed to a different channel with the logconfig command.',
          ].join('\n'),
          color: COLORS.info,
          fields: [
            { name: 'Mode', value: session.data.logMode === 'auto' ? 'create private channels' : 'select existing channels', inline: true },
            ...(session.data.logAutoCreated
              ? [{ name: 'Created', value: String(session.data.logAutoCreated), inline: true }]
              : []),
          ],
          footer: `${session.guild.name} | Step 7 of ${STEPS.length}`,
        }),
        components: [
          row(
            new ButtonBuilder().setCustomId('setup:log:auto').setLabel('Create Channels').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('setup:log:manual').setLabel('Select Existing').setStyle(ButtonStyle.Secondary),
          ),
          row(
            new ButtonBuilder().setCustomId('setup:next').setLabel('Continue').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('setup:back').setLabel('Back').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setup:cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger),
          ),
        ],
      };

    case 'log_slot': {
      const slot = SLOT_ORDER[session.data.logSlotIndex];
      const meta = LOG_CHANNEL_SLOTS[slot];
      const assigned = session.data.logChannels[slot];

      return {
        embed: baseEmbed({
          title: `Log Channel: ${meta.label}`,
          description: [
            meta.description,
            '',
            assigned ? `Assigned to <#${assigned}>.` : 'Not assigned yet. Select a channel below, or skip this slot.',
            '',
            `Slot ${session.data.logSlotIndex + 1} of ${SLOT_ORDER.length}. Use the logconfig command later to route individual events elsewhere.`,
          ].join('\n'),
          color: COLORS.info,
          footer: `${session.guild.name} | Step 8 of ${STEPS.length}`,
        }),
        components: [
          row(
            new ChannelSelectMenuBuilder()
              .setCustomId('setup:log:select')
              .setPlaceholder(`Select the ${meta.label} channel`)
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
              .setMinValues(1)
              .setMaxValues(1),
          ),
          row(
            new ButtonBuilder().setCustomId('setup:log:skip').setLabel('Skip Slot').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setup:back').setLabel('Back').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setup:cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger),
          ),
        ],
      };
    }

    case 'log_events': {
      const selected = session.data.enabledEvents || Object.entries(LOG_EVENTS)
        .filter(([, meta]) => meta.defaultEnabled)
        .map(([key]) => key);

      const options = Object.entries(LOG_EVENTS).slice(0, 25).map(([key, meta]) => ({
        label: meta.label.slice(0, 90),
        value: key,
        description: `${(LOG_CATEGORIES[meta.category] || {}).label || meta.category} - ${meta.description}`.slice(0, 95),
        default: selected.includes(key),
      }));

      return {
        embed: baseEmbed({
          title: 'Log Event Types',
          description: [
            'Choose which event types are logged. Every event can be toggled individually later with the logconfig command, and routed to its own channel.',
            '',
            'Deselecting an event stops the bot from sending that log entry at all, which reduces channel noise.',
          ].join('\n'),
          color: COLORS.info,
          fields: [{
            name: 'Currently Selected',
            value: `${selected.length} of ${Object.keys(LOG_EVENTS).length} event types`,
            inline: true,
          }],
          footer: `${session.guild.name} | Step 9 of ${STEPS.length}`,
        }),
        components: [
          row(
            new StringSelectMenuBuilder()
              .setCustomId('setup:events:select')
              .setPlaceholder('Select log events to enable')
              .setMinValues(0)
              .setMaxValues(options.length)
              .addOptions(options),
          ),
          row(
            new ButtonBuilder().setCustomId('setup:next').setLabel('Continue').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('setup:back').setLabel('Back').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setup:cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger),
          ),
        ],
      };
    }

    case 'automod':
      return {
        embed: baseEmbed({
          title: 'Automod Preset',
          description: [
            'Choose a starting configuration. Every rule can be tuned individually afterwards with the automod command, including punishments, thresholds, and the escalation ladder.',
            '',
            `Selected: ${AUTOMOD_PRESETS[session.data.automodPreset].label} - ${AUTOMOD_PRESETS[session.data.automodPreset].description}`,
            '',
            'Note: there is no flood detection by design. Repeat offenders escalate through strikes instead.',
          ].join('\n'),
          color: COLORS.info,
          fields: [
            { name: 'Raid Protection', value: 'Enabled by default: 8 joins in 30 seconds triggers an alert. Set the action to lockdown with the automod command if you want automatic locking.', inline: false },
          ],
          footer: `${session.guild.name} | Step 10 of ${STEPS.length}`,
        }),
        components: [
          row(
            new ButtonBuilder().setCustomId('setup:automod:recommended').setLabel('Recommended').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('setup:automod:strict').setLabel('Strict').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('setup:automod:minimal').setLabel('Minimal').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('setup:automod:skip').setLabel('Skip').setStyle(ButtonStyle.Secondary),
          ),
          row(
            new ButtonBuilder().setCustomId('setup:next').setLabel('Continue').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('setup:back').setLabel('Back').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setup:cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger),
          ),
        ],
      };

    case 'lockdown':
      return {
        embed: baseEmbed({
          title: 'Lockdown Defaults',
          description: [
            'When a channel or the server is locked, the bot denies Send Messages for the roles selected here. Leave it empty to deny the default role only.',
            '',
            `Automatic unlock: ${session.data.autoUnlockMinutes > 0 ? `${session.data.autoUnlockMinutes} minutes after a lockdown` : 'disabled'}`,
          ].join('\n'),
          color: COLORS.info,
          fields: [
            {
              name: 'Selected Roles',
              value: session.data.lockdownRoleIds.length > 0
                ? session.data.lockdownRoleIds.map((id) => `<@&${id}>`).join(', ')
                : '@everyone only',
              inline: false,
            },
          ],
          footer: `${session.guild.name} | Step 11 of ${STEPS.length}`,
        }),
        components: [
          row(
            new StringSelectMenuBuilder()
              .setCustomId('setup:lockdown:roles')
              .setPlaceholder('Roles to deny during lockdown')
              .setMinValues(0)
              .setMaxValues(Math.min(10, Math.max(1, session.guild.roles.cache.size - 1)))
              .addOptions(
                session.guild.roles.cache
                  .filter((role) => role.id !== session.guild.id && !role.managed)
                  .sort((a, b) => b.position - a.position)
                  .first(25)
                  .map((role) => ({ label: role.name.slice(0, 90), value: role.id, default: session.data.lockdownRoleIds.includes(role.id) })),
              ),
          ),
          row(
            new ButtonBuilder().setCustomId('setup:lockdown:unlock:0').setLabel('No Auto Unlock').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setup:lockdown:unlock:30').setLabel('Unlock After 30m').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setup:lockdown:unlock:120').setLabel('Unlock After 2h').setStyle(ButtonStyle.Secondary),
          ),
          row(
            new ButtonBuilder().setCustomId('setup:next').setLabel('Continue').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('setup:back').setLabel('Back').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setup:cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger),
          ),
        ],
      };

    case 'behaviour':
      return {
        embed: baseEmbed({
          title: 'Behaviour',
          description: [
            'Reason requirement: when enabled, every moderation command refuses to run without a reason. This is the recommended default for accountability.',
            '',
            'Direct message on punishment: when enabled, the bot sends the punished member an embed explaining the action and the reason. Members with direct messages closed are skipped silently, and the case records that the notice was not delivered.',
          ].join('\n'),
          color: COLORS.info,
          fields: [
            { name: 'Reason Required', value: session.data.requireReason ? 'yes' : 'no', inline: true },
            { name: 'DM On Punishment', value: session.data.dmOnPunishment ? 'yes' : 'no', inline: true },
          ],
          footer: `${session.guild.name} | Step 12 of ${STEPS.length}`,
        }),
        components: [
          row(
            new ButtonBuilder().setCustomId('setup:behaviour:reason').setLabel('Toggle Reason Requirement').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('setup:behaviour:dm').setLabel('Toggle DM Notifications').setStyle(ButtonStyle.Primary),
          ),
          row(
            new ButtonBuilder().setCustomId('setup:next').setLabel('Review Summary').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('setup:back').setLabel('Back').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('setup:cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger),
          ),
        ],
      };

    case 'summary':
    default: {
      const enabledEvents = session.data.enabledEvents || Object.entries(LOG_EVENTS)
        .filter(([, meta]) => meta.defaultEnabled)
        .map(([key]) => key);

      const slots = SLOT_ORDER
        .map((slot) => `${LOG_CHANNEL_SLOTS[slot].label}: ${session.data.logChannels[slot] ? `<#${session.data.logChannels[slot]}>` : 'not set'}`)
        .join('\n');

      return {
        embed: baseEmbed({
          title: 'Setup Summary',
          description: 'Review the configuration below. Nothing has been saved yet. Press Save to write it to the database.',
          color: COLORS.notice,
          fields: [
            {
              name: 'Commands',
              value: [
                `Prefix: \`${session.data.prefix}\``,
                `Prefix commands: ${session.data.prefixEnabled ? 'enabled' : 'disabled'}`,
              ].join('\n'),
              inline: false,
            },
            {
              name: 'Roles',
              value: [
                `Administrators: ${session.data.adminRoleIds.map((id) => `<@&${id}>`).join(', ') || 'not set'}`,
                `Moderators: ${session.data.modRoleIds.map((id) => `<@&${id}>`).join(', ') || 'not set'}`,
                `Trusted: ${session.data.trustedRoleIds.map((id) => `<@&${id}>`).join(', ') || 'not set'}`,
              ].join('\n'),
              inline: false,
            },
            {
              name: 'Muting',
              value: session.data.createMuteRole
                ? 'A new mute role will be created and applied to all text channels'
                : (session.data.mutedRoleId ? `Existing mute role: <@&${session.data.mutedRoleId}>` : 'Native timeouts only'),
              inline: false,
            },
            { name: 'Log Channels', value: slots, inline: false },
            { name: 'Log Events', value: `${enabledEvents.length} of ${Object.keys(LOG_EVENTS).length} event types enabled`, inline: false },
            { name: 'Automod', value: `${AUTOMOD_PRESETS[session.data.automodPreset].label}: ${AUTOMOD_PRESETS[session.data.automodPreset].description}`, inline: false },
            {
              name: 'Lockdown',
              value: [
                `Denied roles: ${session.data.lockdownRoleIds.map((id) => `<@&${id}>`).join(', ') || '@everyone only'}`,
                `Auto unlock: ${session.data.autoUnlockMinutes > 0 ? `${session.data.autoUnlockMinutes} minutes` : 'disabled'}`,
              ].join('\n'),
              inline: false,
            },
            {
              name: 'Behaviour',
              value: [
                `Reason required: ${session.data.requireReason ? 'yes' : 'no'}`,
                `DM on punishment: ${session.data.dmOnPunishment ? 'yes' : 'no'}`,
              ].join('\n'),
              inline: false,
            },
          ],
          footer: `${session.guild.name} | Step 13 of ${STEPS.length}`,
        }),
        components: [row(
          new ButtonBuilder().setCustomId('setup:save').setLabel('Save Configuration').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('setup:back').setLabel('Back').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('setup:cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger),
        )],
      };
    }
  }
}

/** Build the role selection screen for one of the three role steps. */
function roleStep(session, step) {
  const config = {
    admin_roles: {
      field: 'adminRoleIds',
      title: 'Administrator Roles',
      description: 'Members with these roles can run configuration commands, view configuration, export logs, and configure automod. They are also treated as moderators.',
      stepNumber: 4,
    },
    mod_roles: {
      field: 'modRoleIds',
      title: 'Moderator Roles',
      description: 'Members with these roles can run moderation commands: kick, ban, mute, warn, purge, lockdown, and the rest.',
      stepNumber: 5,
    },
    trusted_roles: {
      field: 'trustedRoleIds',
      title: 'Trusted Roles',
      description: 'Members with these roles can use read-only staff commands such as whois details for others. Choose roles carefully: trusted is above a regular member but below a moderator.',
      stepNumber: 6,
    },
  }[step];

  const selected = session.data[config.field] || [];

  const roleOptions = session.guild.roles.cache
    .filter((role) => role.id !== session.guild.id && !role.managed)
    .sort((a, b) => b.position - a.position)
    .first(25)
    .map((role) => ({
      label: role.name.slice(0, 90),
      value: role.id,
      description: `${role.members.size} member${role.members.size === 1 ? '' : 's'}`,
      default: selected.includes(role.id),
    }));

  if (roleOptions.length === 0) {
    return {
      embed: errorEmbed({
        title: config.title,
        description: 'This server has no roles that can be assigned. Create a role first, then re-run the wizard.',
      }),
      components: [row(
        new ButtonBuilder().setCustomId('setup:next').setLabel('Skip').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('setup:cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger),
      )],
    };
  }

  return {
    embed: baseEmbed({
      title: config.title,
      description: [
        config.description,
        '',
        'Server administrators and the server owner always keep access regardless of these roles, and members listed in the bot owner configuration bypass every check.',
        '',
        'You can skip this step and set it later by re-running the wizard.',
      ].join('\n'),
      color: COLORS.info,
      fields: [{
        name: 'Selected',
        value: selected.length > 0 ? selected.map((id) => `<@&${id}>`).join(', ') : 'None',
        inline: false,
      }],
      footer: `${session.guild.name} | Step ${config.stepNumber} of ${STEPS.length}`,
    }),
    components: [
      row(
        new StringSelectMenuBuilder()
          .setCustomId(`setup:role:${config.field}`)
          .setPlaceholder(`Select ${config.title.toLowerCase()}`)
          .setMinValues(0)
          .setMaxValues(Math.min(10, roleOptions.length))
          .addOptions(roleOptions),
      ),
      row(
        new ButtonBuilder().setCustomId('setup:next').setLabel('Continue').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('setup:back').setLabel('Back').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('setup:cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger),
      ),
    ],
  };
}

/** Build an action row from buttons. */
function row(...components) {
  const builder = new ActionRowBuilder();
  for (const component of components) builder.addComponents(component);
  return builder;
}

/** Render and send the current step. */
async function render(session) {
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  scheduleExpiry(session);

  const { embed, components } = renderStep(session);
  await sendToSession(session, { embeds: [embed], components: components || [] });
}

/**
 * Handle a component interaction belonging to the wizard.
 *
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<boolean>} true when the interaction was consumed
 */
async function handleComponent(client, interaction) {
  if (!interaction.customId || !interaction.customId.startsWith('setup:')) return false;
  if (!interaction.guild) return false;

  const session = get(interaction.guild.id, interaction.user.id);
  if (!session) {
    await interaction.deferUpdate().catch(() => null);
    return true;
  }

  // Only the member who started the wizard may drive it.
  if (session.member.id !== interaction.user.id) {
    await interaction.reply({ embeds: [errorEmbed({ title: 'Setup In Progress', description: 'Another administrator is running the setup wizard in this server.' })], ephemeral: true }).catch(() => null);
    return true;
  }

  const [prefix, group, action, extra] = interaction.customId.split(':');
  void prefix;

  try {
    if (interaction.isStringSelectMenu() || interaction.isChannelSelectMenu()) {
      await handleSelect(session, group, interaction);
    } else if (interaction.isButton()) {
      await handleButton(session, group, action, extra);
    } else {
      await interaction.deferUpdate().catch(() => null);
    }
  } catch (error) {
    log.warn('Wizard interaction failed', { group, code: error && error.code });
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ embeds: [errorEmbed({ title: 'Setup Error', description: 'That step could not be completed. Try again or restart the wizard with the setup command.' })], ephemeral: true }).catch(() => null);
    }
  }

  return true;
}

/** Route button presses. */
async function handleButton(session, group, action, extra) {
  switch (group) {
    case 'next':
      session.awaitingText = null;
      if (session.stepIndex < STEPS.length - 1) session.stepIndex += 1;
      await render(session);
      return;

    case 'back':
      session.awaitingText = null;
      if (STEPS[session.stepIndex] === 'log_slot' && session.data.logSlotIndex > 0) {
        session.data.logSlotIndex -= 1;
      } else if (session.stepIndex > 0) {
        session.stepIndex -= 1;
        if (STEPS[session.stepIndex] === 'log_slot') session.data.logSlotIndex = SLOT_ORDER.length - 1;
      }
      await render(session);
      return;

    case 'cancel':
      destroy(session.key);
      await sendToSession(session, {
        embeds: [errorEmbed({ title: 'Setup Cancelled', description: 'No changes were saved. Run the setup command to start again.' })],
        components: [],
      });
      return;

    case 'prefix':
      if (action === 'change') {
        session.awaitingText = 'prefix';
        await sendToSession(session, {
          embeds: [baseEmbed({
            title: 'Command Prefix',
            description: 'Type the new prefix in this channel now. It can be up to 5 characters with no spaces.',
            color: COLORS.info,
            fields: [{ name: 'Current', value: `\`${session.data.prefix}\``, inline: true }],
            footer: session.guild.name,
          })],
          components: [row(new ButtonBuilder().setCustomId('setup:cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger))],
        });
        return;
      }
      if (action === 'toggle') {
        session.data.prefixEnabled = !session.data.prefixEnabled;
        session.stepIndex = STEPS.indexOf('prefix_toggle');
        await render(session);
        return;
      }
      return;

    case 'mute':
      if (action === 'create') {
        session.data.createMuteRole = true;
        session.data.muteRoleEnabled = true;
      } else if (action === 'none') {
        session.data.createMuteRole = false;
        session.data.muteRoleEnabled = false;
      }
      await render(session);
      return;

    case 'log':
      if (action === 'auto') {
        session.data.logMode = 'auto';
        session.data.logAutoCreated = 'pending';
        await render(session);
        return;
      }
      if (action === 'manual') {
        session.data.logMode = 'manual';
        session.data.logSlotIndex = 0;
        session.stepIndex = STEPS.indexOf('log_slot');
        await render(session);
        return;
      }
      if (action === 'skip') {
        if (session.data.logSlotIndex < SLOT_ORDER.length - 1) {
          session.data.logSlotIndex += 1;
          await render(session);
        } else {
          session.stepIndex = STEPS.indexOf('log_events');
          await render(session);
        }
        return;
      }
      return;

    case 'automod':
      if (AUTOMOD_PRESETS[action]) {
        session.data.automodPreset = action;
      }
      await render(session);
      return;

    case 'lockdown':
      if (action === 'unlock') {
        session.data.autoUnlockMinutes = parseInt(extra, 10) || 0;
      }
      await render(session);
      return;

    case 'behaviour':
      if (action === 'reason') session.data.requireReason = !session.data.requireReason;
      if (action === 'dm') session.data.dmOnPunishment = !session.data.dmOnPunishment;
      await render(session);
      return;

    case 'save':
      await save(session);
      return;

    default:
      await render(session);
  }
}

/** Route select menu submissions. */
async function handleSelect(session, group, interaction) {
  const values = interaction.values || [];

  switch (group) {
    case 'role': {
      // The field name is the third segment of the custom id.
      const field = interaction.customId.split(':')[2];
      if (['adminRoleIds', 'modRoleIds', 'trustedRoleIds'].includes(field)) {
        session.data[field] = values;
      }
      await interaction.deferUpdate().catch(() => null);
      await render(session);
      return;
    }

    case 'events': {
      session.data.enabledEvents = values;
      await interaction.deferUpdate().catch(() => null);
      await render(session);
      return;
    }

    case 'lockdown': {
      session.data.lockdownRoleIds = values;
      await interaction.deferUpdate().catch(() => null);
      await render(session);
      return;
    }

    case 'log': {
      const slot = SLOT_ORDER[session.data.logSlotIndex];
      session.data.logChannels[slot] = values[0];
      if (session.data.logSlotIndex < SLOT_ORDER.length - 1) {
        session.data.logSlotIndex += 1;
      } else {
        session.stepIndex = STEPS.indexOf('log_events');
      }
      await interaction.deferUpdate().catch(() => null);
      await render(session);
      return;
    }

    default:
      await interaction.deferUpdate().catch(() => null);
  }
}

/**
 * Handle typed replies while a session waits for text.
 *
 * @param {import('discord.js').Message} message
 * @returns {Promise<boolean>} true when the message was consumed
 */
async function handleMessage(message) {
  if (!message.guild || message.author.bot) return false;
  const session = get(message.guild.id, message.author.id);
  if (!session || !session.awaitingText) return false;

  const mode = session.awaitingText;
  session.awaitingText = null;

  if (mode === 'prefix') {
    const prefix = sanitizePrefix(message.content);
    if (!prefix) {
      session.awaitingText = 'prefix';
      await message.reply({
        embeds: [errorEmbed({
          title: 'Invalid Prefix',
          description: 'Use up to 5 characters with no spaces, mentions, or backticks. Try again, or press Cancel in the wizard message.',
        })],
      }).catch(() => null);
      return true;
    }
    session.data.prefix = prefix;
  }

  // Delete the typed input when the bot can, so the channel stays clean.
  if (session.guild.members.me && session.guild.members.me.permissions.has(PermissionFlagsBits.ManageMessages)) {
    await message.delete().catch(() => null);
  }

  await render(session);
  return true;
}

/**
 * Write the collected configuration.
 * @param {object} session
 */
async function save(session) {
  const guild = session.guild;
  const data = session.data;

  // 1. Mute role: create and apply when requested.
  let mutedRoleId = data.mutedRoleId;
  let muteRoleEnabled = data.muteRoleEnabled;

  if (data.createMuteRole) {
    const created = await createMuteRole(guild).catch((error) => {
      log.warn('Mute role creation failed', { guildId: guild.id, code: error && error.code });
      return null;
    });
    if (created) {
      mutedRoleId = created.id;
      muteRoleEnabled = true;
      await applyMuteRoleOverwrites(guild, created.id);
    } else {
      muteRoleEnabled = Boolean(mutedRoleId);
    }
  }

  // 2. Log channels: create the private category set when requested.
  let logChannels = { ...data.logChannels };
  if (data.logMode === 'auto' && data.logAutoCreated) {
    const created = await createLogChannels(guild).catch((error) => {
      log.warn('Log channel creation failed', { guildId: guild.id, code: error && error.code });
      return null;
    });
    if (created) logChannels = { ...logChannels, ...created };
  }

  // 3. Guild configuration document.
  const guildPatch = {
    prefix: data.prefix,
    prefixEnabled: data.prefixEnabled,
    adminRoleIds: data.adminRoleIds,
    modRoleIds: data.modRoleIds,
    trustedRoleIds: data.trustedRoleIds,
    mutedRoleId,
    muteRoleEnabled,
    requireReason: data.requireReason,
    dmOnPunishment: data.dmOnPunishment,
    lockdown: {
      roleIds: data.lockdownRoleIds,
      channelIds: [],
      autoUnlockMinutes: data.autoUnlockMinutes,
    },
    configuredAt: Date.now(),
    configuredBy: session.member.id,
    guildName: guild.name,
  };

  await repo('guilds').updateConfig(guild.id, guildPatch);

  // 4. Logging document: channels plus per-event enablement.
  const loggingDefaults = defaultLoggingConfig();
  const enabledEvents = data.enabledEvents || Object.entries(LOG_EVENTS)
    .filter(([, meta]) => meta.defaultEnabled)
    .map(([key]) => key);

  const eventPatch = {};
  for (const key of Object.keys(LOG_EVENTS)) {
    eventPatch[key] = { enabled: enabledEvents.includes(key), channelId: null };
  }

  await repo('guilds').updateLogging(guild.id, {
    channels: { ...loggingDefaults.channels, ...logChannels },
    events: eventPatch,
  });

  // 5. Automod preset, merged onto the defaults so no key is ever missing.
  const automodBase = defaultAutomodConfig();
  const presetConfig = AUTOMOD_PRESETS[data.automodPreset] || AUTOMOD_PRESETS.recommended;
  const automod = presetConfig.apply(automodBase);

  await repo('guilds').updateAutomod(guild.id, {
    enabled: automod.enabled,
    rules: automod.rules,
    escalation: automod.escalation,
    raid: automod.raid,
    exemptions: automod.exemptions,
  });

  destroy(session.key);

  const configuredChannels = Object.entries(logChannels)
    .filter(([, value]) => Boolean(value))
    .map(([slot, value]) => `${LOG_CHANNEL_SLOTS[slot] ? LOG_CHANNEL_SLOTS[slot].label : slot}: <#${value}>`);

  await sendToSession(session, {
    embeds: [successEmbed({
      title: 'Setup Complete',
      color: COLORS.success,
      description: [
        'The configuration has been saved to the database.',
        '',
        `Prefix: \`${data.prefix}\` (${data.prefixEnabled ? 'prefix commands enabled' : 'prefix commands disabled'})`,
        `Moderator roles: ${data.modRoleIds.length}`,
        `Administrator roles: ${data.adminRoleIds.length}`,
        `Trusted roles: ${data.trustedRoleIds.length}`,
        `Mute role: ${muteRoleEnabled && mutedRoleId ? `<@&${mutedRoleId}>` : 'not used'}`,
        `Log event types enabled: ${enabledEvents.length}`,
        `Automod preset: ${presetConfig.label}`,
      ].join('\n'),
      fields: [
        { name: 'Log Channels', value: configuredChannels.join('\n').slice(0, 1024) || 'None configured', inline: false },
        {
          name: 'Next Steps',
          value: [
            `Use \`${data.prefix}logconfig\` to route individual event types to different channels.`,
            `Use \`${data.prefix}automod\` to tune rules, punishments, and the escalation ladder.`,
            `Use \`${data.prefix}config\` to review the saved configuration at any time.`,
          ].join('\n'),
          inline: false,
        },
      ],
      footer: `${guild.name} | Configured by ${session.member.user.tag}`,
    })],
    components: [],
  });

  log.info('Guild setup completed', { guildId: guild.id, by: session.member.id });
}

/** Create a mute role with no granted permissions. */
async function createMuteRole(guild) {
  const existing = guild.roles.cache.find((role) => role.name.toLowerCase() === 'muted');
  if (existing) return existing;

  return guild.roles.create({
    name: 'Muted',
    color: 0x4f545c,
    permissions: [],
    reason: 'Moderation setup wizard: mute role',
    mentionable: false,
  });
}

/** Deny Send Messages and Add Reactions for the mute role in text channels. */
async function applyMuteRoleOverwrites(guild, roleId) {
  const channels = guild.channels.cache.filter((channel) => channel.isTextBased && channel.isTextBased());
  let applied = 0;

  for (const channel of channels.values()) {
    const updated = await channel.permissionOverwrites.edit(roleId, {
      SendMessages: false,
      AddReactions: false,
      Speak: false,
    }, { reason: 'Mute role configuration' }).then(() => true).catch(() => false);
    if (updated) applied += 1;
  }

  log.info('Mute role overwrites applied', { guildId: guild.id, channels: applied });
  return applied;
}

/** Create a private category with one channel per log slot. */
async function createLogChannels(guild) {
  const staffRoleIds = [...guild.roles.cache.values()]
    .filter((role) => role.permissions.has(PermissionFlagsBits.ViewAuditLog) || role.permissions.has(PermissionFlagsBits.ManageMessages))
    .map((role) => role.id);

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    ...staffRoleIds.map((roleId) => ({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] })),
  ];

  const category = await guild.channels.create({
    name: 'Moderation',
    type: ChannelType.GuildCategory,
    permissionOverwrites: overwrites,
    reason: 'Moderation setup wizard: private log category',
  });

  const created = {};
  const names = {
    modLog: 'mod-log',
    messageLog: 'message-log',
    joinLeaveLog: 'join-leave-log',
    voiceLog: 'voice-log',
    serverLog: 'server-log',
    automodLog: 'automod-log',
  };

  for (const [slot, name] of Object.entries(names)) {
    const channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: category.id,
      reason: 'Moderation setup wizard: log channel',
    }).catch(() => null);
    if (channel) created[slot] = channel.id;
  }

  return created;
}

module.exports = {
  start,
  get,
  destroy,
  render,
  handleComponent,
  handleMessage,
  isAwaitingText,
  sessions,
  STEPS,
  AUTOMOD_PRESETS,
  SLOT_ORDER,
};
