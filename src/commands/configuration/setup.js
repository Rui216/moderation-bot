'use strict';

/**
 * Start the interactive setup wizard.
 *
 * Re-runnable at any time: each run starts from the current configuration and
 * only writes to the database when the final confirmation screen is accepted.
 */

const { COLORS, MESSAGES } = require('../../config/constants');
const { errorEmbed } = require('../../utils/embeds');
const { logger } = require('../../utils/logger');
const setupWizard = require('../../core/setupWizard');

const log = logger.child('command');

module.exports = {
  name: 'setup',
  aliases: ['wizard', 'configure'],
  description: 'Run the interactive setup wizard to configure moderation for this server.',
  usage: 'setup',
  examples: ['setup'],
  permission: 'admin',
  action: 'setup',
  slashOptions: [],

  async execute(ctx) {
    // Setup decides who the staff are, so it checks Discord permissions directly
    // rather than the configured admin roles, which may not exist yet.
    const isAdministrator = Boolean(ctx.member && ctx.member.permissions && ctx.member.permissions.has('Administrator'));
    const isOwner = ctx.guild.ownerId === ctx.author.id;
    const isBotOwner = (ctx.appConfig.discord.ownerIds || []).includes(ctx.author.id);
    if (!isAdministrator && !isOwner && !isBotOwner) {
      await ctx.replyEmbed(errorEmbed({
        title: 'Administrators Only',
        description: 'Only server administrators can run setup.',
      }));
      return;
    }

    // The wizard needs permission to create roles and channels if the
    // administrator chooses those options.
    const me = ctx.guild.members.me;
    if (!me) {
      await ctx.replyEmbed(errorEmbed({ title: 'Setup Unavailable', description: MESSAGES.genericError }));
      return;
    }

    const canCreateChannels = me.permissions.has('ManageChannels');
    const canCreateRoles = me.permissions.has('ManageRoles');

    if (!canCreateChannels && !canCreateRoles) {
      await ctx.replyEmbed(errorEmbed({
        title: 'Missing Permissions',
        description: 'The bot needs the Manage Channels and Manage Roles permissions to create the log channels and mute role during setup. '
          + 'You can still select existing channels and skip the mute role, but granting both permissions is recommended.',
        color: COLORS.notice,
      }));
      // Continue anyway: manual selection is still possible.
    }

    log.info('Setup wizard started', { guildId: ctx.guild.id, by: ctx.author.id });

    await setupWizard.start({
      client: ctx.client,
      guild: ctx.guild,
      member: ctx.member,
      channel: ctx.channel,
      interaction: ctx.interaction || null,
      config: ctx.config,
    });
  },
};
