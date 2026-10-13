'use strict';

/**
 * Command registry.
 *
 * Commands are plain CommonJS modules under src/commands, grouped in folders
 * that map to categories. The registry loads them once at startup, validates
 * their shape, and exposes lookups plus a permission-aware listing used by the
 * help command.
 */

const fs = require('fs');
const path = require('path');

const { LEVEL_WEIGHT, PERMISSION_LEVELS } = require('../config/constants');
const { logger } = require('../utils/logger');
const permissionService = require('../services/permissionService');

const log = logger.child('registry');

/** name -> command definition */
const commands = new Map();
/** alias -> name */
const aliases = new Map();
/** category -> command names */
const categories = new Map();

/** Folder name to display category label. */
const CATEGORY_LABELS = {
  moderation: 'Moderation',
  channels: 'Channels',
  roles: 'Roles',
  configuration: 'Configuration',
  utility: 'Utility',
  automod: 'Automod',
  logging: 'Logging',
};

/**
 * Validate a command definition.
 * @param {object} definition
 * @param {string} source
 * @returns {string[]} list of problems
 */
function validateCommand(definition, source) {
  const problems = [];
  if (!definition || typeof definition !== 'object') return ['module does not export an object'];
  if (!definition.name || typeof definition.name !== 'string') problems.push('missing "name"');
  if (!definition.description || typeof definition.description !== 'string') problems.push('missing "description"');
  if (typeof definition.execute !== 'function') problems.push('missing "execute" function');
  if (definition.permission && !PERMISSION_LEVELS[String(definition.permission).toUpperCase()]) {
    problems.push(`unknown permission level "${definition.permission}"`);
  }
  if (definition.usage && typeof definition.usage !== 'string') problems.push('"usage" must be a string');
  if (definition.aliases && !Array.isArray(definition.aliases)) problems.push('"aliases" must be an array');
  if (problems.length > 0) log.warn('Skipping invalid command', { source, problems });
  return problems;
}

/**
 * Register a single command definition.
 * @param {object} definition
 * @param {string} [source]
 */
function register(definition, source = 'manual') {
  if (validateCommand(definition, source).length > 0) return false;

  if (commands.has(definition.name)) {
    log.warn('Duplicate command name ignored', { name: definition.name, source });
    return false;
  }

  const normalized = {
    category: 'utility',
    permission: PERMISSION_LEVELS.MODERATOR,
    usage: definition.name,
    aliases: [],
    examples: [],
    guildOnly: true,
    hidden: false,
    ...definition,
    permission: String(definition.permission || PERMISSION_LEVELS.MODERATOR).toLowerCase(),
  };

  commands.set(normalized.name, normalized);

  for (const alias of normalized.aliases) {
    if (typeof alias !== 'string' || !alias) continue;
    if (aliases.has(alias) || commands.has(alias)) {
      log.warn('Duplicate alias ignored', { alias, command: normalized.name });
      continue;
    }
    aliases.set(alias, normalized.name);
  }

  if (!categories.has(normalized.category)) categories.set(normalized.category, []);
  categories.get(normalized.category).push(normalized.name);

  return true;
}

/**
 * Load every command module from a directory tree.
 * @param {string} directory absolute path to the commands root
 * @returns {number} number of commands registered
 */
function loadDirectory(directory) {
  const root = path.resolve(directory);
  if (!fs.existsSync(root)) {
    log.warn('Commands directory not found', { directory: root });
    return 0;
  }

  let count = 0;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;

      try {
        // eslint-disable-next-line global-require, import/no-dynamic-require
        const definition = require(fullPath);
        const category = path.basename(dir);
        if (register({ ...definition, category: definition.category || category }, fullPath)) {
          count += 1;
        }
      } catch (error) {
        // A broken command file must not stop the bot from booting.
        log.error('Failed to load command module', { source: fullPath, message: error && error.message });
      }
    }
  };

  walk(root);
  log.info('Commands loaded', { count, categories: categories.size });
  return count;
}

/** Look up a command by name or alias. */
function get(name) {
  if (!name) return null;
  const key = String(name).toLowerCase();
  if (commands.has(key)) return commands.get(key);
  const target = aliases.get(key);
  return target ? commands.get(target) : null;
}

/** Every command definition. */
function all() {
  return [...commands.values()];
}

/** Commands grouped by category, with display labels. */
function grouped() {
  const output = [];
  for (const [category, names] of categories.entries()) {
    output.push({
      category,
      label: CATEGORY_LABELS[category] || category,
      commands: names.map((name) => commands.get(name)).filter(Boolean),
    });
  }
  return output.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Commands a member is allowed to run. Used by the help command so it never
 * advertises commands the caller cannot use.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {object} config
 * @param {string[]} ownerIds
 * @returns {object[]}
 */
function visibleFor(member, config, ownerIds = []) {
  const resolved = permissionService.resolveLevel(member, config, ownerIds);
  return all().filter((command) => {
    if (command.hidden) return false;
    const required = LEVEL_WEIGHT[command.permission] ?? LEVEL_WEIGHT.moderator;
    return resolved.weight >= required;
  });
}

/** Commands grouped by category, filtered by permission. */
function groupedFor(member, config, ownerIds = []) {
  const visible = new Set(visibleFor(member, config, ownerIds).map((command) => command.name));
  return grouped()
    .map((group) => ({ ...group, commands: group.commands.filter((command) => visible.has(command.name)) }))
    .filter((group) => group.commands.length > 0);
}

/** Registry statistics for diagnostics. */
function stats() {
  return {
    commands: commands.size,
    aliases: aliases.size,
    categories: [...categories.keys()],
  };
}

/** Test helper: clear the registry. */
function reset() {
  commands.clear();
  aliases.clear();
  categories.clear();
}

module.exports = {
  register,
  loadDirectory,
  get,
  all,
  grouped,
  groupedFor,
  visibleFor,
  stats,
  reset,
  CATEGORY_LABELS,
};
