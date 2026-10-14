'use strict';

const { EPHEMERAL } = require('../utils/flags');

/**
 * Command context.
 *
 * A single object is handed to every command, whether it was invoked through a
 * prefix message or an application command. Commands therefore never touch
 * discord.js reply plumbing directly, and every response goes through the
 * shared embed templates.
 *
 * Response rules enforced here:
 *   - Replies are embeds, never plain text.
 *   - Unexpected errors produce a generic embed; the full error is logged
 *     privately and never shown in Discord.
 *   - Command messages can be auto-deleted when the guild enables it.
 */

const { ChannelType } = require('discord.js');

const { COLORS, MESSAGES } = require('../config/constants');
const { baseEmbed, errorEmbed, noticeEmbed, successEmbed, infoEmbed } = require('../utils/embeds');
const { safeErrorMessage, isUserError } = require('../utils/errors');
const { logger } = require('../utils/logger');
const parser = require('../utils/parser');

const log = logger.child('context');

class CommandContext {
  /**
   * @param {object} options
   * @param {import('discord.js').Client} options.client
   * @param {import('discord.js').Message} [options.message] prefix invocation source
   * @param {import('discord.js').ChatInputCommandInteraction} [options.interaction] slash invocation source
   * @param {object} options.command command definition
   * @param {string[]} options.args positional arguments
   * @param {string} options.rawArgs raw argument string
   * @param {object} options.flags parsed --flags
   * @param {object} options.config guild configuration document
   * @param {object} options.appConfig environment configuration
   * @param {string} [options.reason] reason extracted by the dispatcher
   */
  constructor(options) {
    this.client = options.client;
    this.message = options.message || null;
    this.interaction = options.interaction || null;
    this.command = options.command;
    this.args = options.args || [];
    this.rawArgs = options.rawArgs || '';
    this.flags = options.flags || {};
    this.config = options.config;
    this.appConfig = options.appConfig;
    this.limits = options.appConfig ? options.appConfig.limits : {};
    this.rawReason = options.reason || '';

    this.guild = this.message ? this.message.guild : (this.interaction ? this.interaction.guild : null);
    this.member = this.message ? this.message.member : (this.interaction ? this.interaction.member : null);
    this.author = this.message ? this.message.author : (this.interaction ? this.interaction.user : null);
    this.channel = this.message ? this.message.channel : (this.interaction ? this.interaction.channel : null);

    // The pipeline calls this "moderator"; keeping both names avoids confusion
    // in service code that has no concept of a slash interaction.
    this.moderator = this.member;
    this.user = this.author;
    this.level = options.level || null;
  }

  /** True when the invocation came from a slash command. */
  get isSlash() {
    return Boolean(this.interaction);
  }

  /**
   * Send an embed to the channel, or edit the interaction reply.
   * @param {object} embed
   * @param {{ephemeral?: boolean, keepCommand?: boolean}} [options]
   */
  async replyEmbed(embed, options = {}) {
    const ephemeral = options.ephemeral !== undefined ? options.ephemeral : this.isSlash;

    if (this.isSlash) {
      if (this.interaction.replied || this.interaction.deferred) {
        return this.interaction.followUp({ embeds: [embed], flags: ephemeral ? EPHEMERAL : 0 }).catch(() => null);
      }
      return this.interaction.reply({ embeds: [embed], flags: ephemeral ? EPHEMERAL : 0 }).catch(() => null);
    }

    const sent = await this.channel.send({ embeds: [embed] }).catch((error) => {
      log.debug('Reply failed', { code: error && error.code, channelId: this.channel ? this.channel.id : null });
      return null;
    });

    if (!options.keepCommand && this.config && this.config.deleteCommandMessages && this.message) {
      await this.message.delete().catch(() => null);
    }
    return sent;
  }

  /**
   * Send several embeds.
   * @param {object[]} embeds
   * @param {{ephemeral?: boolean}} [options]
   */
  async replyEmbeds(embeds, options = {}) {
    const list = (embeds || []).slice(0, 10);
    if (list.length === 0) return null;

    if (this.isSlash) {
      const payload = { embeds: list, flags: (options.ephemeral !== undefined ? options.ephemeral : true) ? EPHEMERAL : 0 };
      if (this.interaction.replied || this.interaction.deferred) {
        return this.interaction.followUp(payload).catch(() => null);
      }
      return this.interaction.reply(payload).catch(() => null);
    }

    return this.channel.send({ embeds: list }).catch(() => null);
  }

  /** Reply with the standard success embed. */
  success(title, description, fields) {
    return this.replyEmbed(successEmbed({ title, description, fields }));
  }

  /** Reply with the standard information embed. */
  info(title, description, fields, footer) {
    return this.replyEmbed(infoEmbed({ title, description, fields, footer }));
  }

  /** Reply with the standard notice embed. */
  notice(title, description, fields) {
    return this.replyEmbed(noticeEmbed({ title, description, fields }));
  }

  /** Reply with the standard error embed using a safe message. */
  error(title, description) {
    return this.replyEmbed(errorEmbed({
      title: title || 'Command Failed',
      description: description || MESSAGES.genericError,
    }));
  }

  /**
   * Reply with a raw embed payload (already built by a service).
   * @param {{embed: object}} result
   */
  replyResult(result) {
    if (result && result.embed) return this.replyEmbed(result.embed);
    return this.replyEmbed(baseEmbed({ title: 'Action Completed', color: COLORS.success }));
  }

  /**
   * Send a loading acknowledgement for actions that take a moment.
   * Slash commands use a deferred reply; prefix commands do not need one.
   */
  async acknowledge() {
    if (!this.isSlash) return;
    if (this.interaction.deferred || this.interaction.replied) return;
    await this.interaction.deferReply({ flags: EPHEMERAL }).catch(() => null);
  }

  /* -------------------------------------------------------------- resolvers */

  resolveMember(query) {
    return parser.resolveMember(this.guild, query);
  }

  resolveUser(query) {
    return parser.resolveUser(this.client, this.guild, query);
  }

  resolveRole(query) {
    return parser.resolveRole(this.guild, query);
  }

  resolveChannel(query) {
    return parser.resolveChannel(this.guild, query);
  }

  /** True when the current channel is a text channel the bot can write to. */
  isTextChannel(channel = this.channel) {
    return Boolean(channel) && (channel.type === ChannelType.GuildText
      || channel.type === ChannelType.GuildAnnouncement
      || channel.isTextBased?.());
  }

  /** Role hierarchy helper bound to the acting moderator. */
  canActOn(target) {
    const hierarchyService = require('../services/hierarchyService');
    hierarchyService.assertCanActOn(this.moderator, target);
    return true;
  }

  /**
   * Handle a thrown error from a command: log it privately and send a safe
   * embed to the user.
   * @param {Error} error
   */
  async handleError(error) {
    if (isUserError(error)) {
      log.debug('Command returned a user error', { command: this.command.name, code: error.code });
      await this.replyEmbed(errorEmbed({ title: 'Command Failed', description: safeErrorMessage(error) }));
      return;
    }

    // Unexpected: full details go to the private log only.
    log.error('Command failed', {
      command: this.command.name,
      guildId: this.guild ? this.guild.id : null,
      code: error && error.code,
      message: error && error.message,
      stack: error && error.stack,
    });

    await this.replyEmbed(errorEmbed({ title: 'Command Failed', description: MESSAGES.genericError }));
  }
}

module.exports = { CommandContext, parser };
