'use strict';

/**
 * Message flags used by replies. discord.js v14 expects flags here, not the
 * older ephemeral option, which it now reports as deprecated.
 */

const { MessageFlags } = require('discord.js');

/** Only the person who ran the command sees the reply. */
const EPHEMERAL = MessageFlags.Ephemeral;

module.exports = { EPHEMERAL };
