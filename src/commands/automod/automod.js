'use strict';

/**
 * Configure the automod modules.
 *
 *   automod                                 overview of every rule
 *   automod enable | disable                toggle the whole module
 *   automod rule <name> <on|off> [punish]   toggle a rule and its punishment
 *   automod set <rule> <option> <value>     tune thresholds
 *   automod words add|remove|clear [word]   maintain the banned word list
 *   automod links allow|block|remove <domain>
 *   automod invites allow|remove <code>
 *   automod escalation ...                  view or edit the escalation ladder
 *   automod raid ...                        raid protection settings
 *   automod exemption role|channel add|remove <id>
 *   automod strikes <member> | reset <member>
 *
 * Punishments: none, delete, warn, mute, tempmute, kick, ban, tempban.
 */

const { COLORS, AUTOMOD_RULES, AUTOMOD_RULE_LABELS, PUNISHMENTS } = require('../../config/constants');
const { baseEmbed, successEmbed } = require('../../utils/embeds');
const { ValidationError } = require('../../utils/errors');
const { sanitizeDomain, sanitizeWord, cleanText } = require('../../utils/sanitize');
const { parseDuration, formatDuration } = require('../../utils/duration');
const { repo } = require('../../db');

/** Options that may be tuned per rule, with their bounds. */
const RULE_OPTIONS = {
  caps: { minLength: { min: 5, max: 200 }, thresholdPercent: { min: 30, max: 100 } },
  mentions: { maxMentions: { min: 1, max: 50 } },
  emoji: { maxEmoji: { min: 1, max: 100 }, thresholdPercent: { min: 10, max: 100 } },
  words: {},
  invites: {},
  links: {},
};

module.exports = {
  name: 'automod',
  aliases: ['am'],
  description: 'View and configure automod rules, punishments, escalation, and raid protection.',
  usage: 'automod <option> [arguments]',
  examples: [
    'automod',
    'automod rule invites on delete',
    'automod words add badword',
    'automod escalation set 5 mute 2h',
    'automod raid threshold 10',
  ],
  permission: 'admin',
  action: null,
  slashOptions: [
    { name: 'option', type: 'string', required: false },
    { name: 'arguments', type: 'string', required: false },
  ],

  async execute(ctx) {
    const action = (ctx.args[0] || 'show').toLowerCase();
    const automod = await repo('guilds').getAutomod(ctx.guild.id, { force: true });

    switch (action) {
      case 'show':
      case 'view':
        await showOverview(ctx, automod);
        return;

      case 'enable':
      case 'disable':
        await toggleModule(ctx, action === 'enable');
        return;

      case 'rule':
        await configureRule(ctx, automod, ctx.args.slice(1));
        return;

      case 'set':
        await setOption(ctx, automod, ctx.args.slice(1));
        return;

      case 'words':
        await manageWords(ctx, automod, ctx.args.slice(1));
        return;

      case 'links':
        await manageDomains(ctx, automod, ctx.args.slice(1));
        return;

      case 'invites':
        await manageInvites(ctx, automod, ctx.args.slice(1));
        return;

      case 'escalation':
        await manageEscalation(ctx, automod, ctx.args.slice(1));
        return;

      case 'raid':
        await manageRaid(ctx, automod, ctx.args.slice(1));
        return;

      case 'exemption':
      case 'exempt':
        await manageExemption(ctx, automod, ctx.args.slice(1));
        return;

      case 'strikes':
        await manageStrikes(ctx, automod, ctx.args.slice(1));
        return;

      default:
        throw new ValidationError(
          'Unknown option. Use show, enable, disable, rule, set, words, links, invites, escalation, raid, exemption, or strikes.',
        );
    }
  },
};

/* ------------------------------------------------------------------ overview */

async function showOverview(ctx, automod) {
  const ruleFields = AUTOMOD_RULES.map((rule) => {
    const setting = automod.rules[rule];
    return {
      name: `${AUTOMOD_RULE_LABELS[rule]} (${rule})`,
      value: [
        `State: ${setting.enabled ? 'enabled' : 'disabled'} | Punishment: ${setting.punishment}`,
        `Strike weight: ${setting.strikeWeight}`,
        ...(rule === 'words' ? [`Words: ${setting.words.length}`] : []),
        ...(rule === 'links' ? [`Allowed: ${setting.allowList.length} | Blocked: ${setting.blockList.length}`] : []),
        ...(rule === 'invites' ? [`Allowed codes: ${setting.allowList.length}`] : []),
        ...(rule === 'caps' ? [`Minimum length: ${setting.minLength} | Threshold: ${setting.thresholdPercent} percent`] : []),
        ...(rule === 'mentions' ? [`Maximum mentions: ${setting.maxMentions}`] : []),
        ...(rule === 'emoji' ? [`Maximum emoji: ${setting.maxEmoji} | Density: ${setting.thresholdPercent} percent`] : []),
      ].join('\n'),
      inline: false,
    };
  });

  const escalation = automod.escalation;
  const steps = escalation.steps.length > 0
    ? escalation.steps.map((step) => `${step.strikes} strikes -> ${step.action}${step.duration ? ` (${step.duration})` : ''}`).join('\n')
    : 'No steps configured';

  await ctx.replyEmbed(baseEmbed({
    title: `Automod: ${ctx.guild.name}`,
    description: [
      `Module: ${automod.enabled ? 'enabled' : 'disabled'}`,
      `Escalation: ${escalation.enabled ? `enabled, ${escalation.windowHours}h window` : 'disabled'}`,
      `Raid protection: ${automod.raid.enabled ? `enabled, ${automod.raid.threshold} joins in ${automod.raid.windowSeconds}s, action: ${automod.raid.action}` : 'disabled'}`,
      `Exemptions: ${automod.exemptions.roleIds.length} roles, ${automod.exemptions.channelIds.length} channels, staff ${automod.exemptions.ignoreStaff ? 'exempt' : 'filtered'}`,
    ].join('\n'),
    color: COLORS.info,
    fields: [
      ...ruleFields,
      { name: 'Escalation Ladder', value: steps.slice(0, 1024), inline: false },
      {
        name: 'Raid Lockdown',
        value: `Channels: ${automod.raid.lockChannelIds.length || 'all text channels'}\nRoles: ${automod.raid.lockRoleIds.length || '@everyone'}\nAuto unlock: ${automod.raid.autoUnlockMinutes ? `${automod.raid.autoUnlockMinutes} minutes` : 'disabled'}`,
        inline: false,
      },
    ],
    footer: `${ctx.guild.name} | automod`,
  }));
}

/* -------------------------------------------------------------------- toggles */

async function toggleModule(ctx, enabled) {
  await repo('guilds').updateAutomod(ctx.guild.id, { enabled });
  await ctx.replyEmbed(successEmbed({
    title: enabled ? 'Automod Enabled' : 'Automod Disabled',
    color: COLORS.success,
    description: enabled
      ? 'Automod rules are evaluated again. Individual rules keep their own settings.'
      : 'No automod rules will be evaluated until automod is enabled again.',
    footer: ctx.guild.name,
  }));
}

async function configureRule(ctx, automod, tokens) {
  const ruleQuery = String(tokens[0] || '').toLowerCase();
  if (!ruleQuery) throw new ValidationError(`Provide a rule name: ${AUTOMOD_RULES.join(', ')}`);

  const rule = AUTOMOD_RULES.find((key) => key === ruleQuery)
    || AUTOMOD_RULES.find((key) => key.startsWith(ruleQuery));
  if (!rule) throw new ValidationError(`Unknown rule. Available rules: ${AUTOMOD_RULES.join(', ')}`);

  const stateArg = String(tokens[1] || '').toLowerCase();
  if (!['on', 'off', 'enable', 'disable'].includes(stateArg)) {
    throw new ValidationError('Specify on or off, optionally followed by a punishment.');
  }

  const enabled = stateArg === 'on' || stateArg === 'enable';
  const patch = { rules: { [rule]: { enabled } } };

  if (tokens[2]) {
    const punishment = tokens[2].toLowerCase();
    if (!PUNISHMENTS.includes(punishment)) {
      throw new ValidationError(`Unknown punishment "${tokens[2]}". Options: ${PUNISHMENTS.join(', ')}`);
    }
    patch.rules[rule].punishment = punishment;
  }

  await repo('guilds').updateAutomod(ctx.guild.id, patch);

  await ctx.replyEmbed(successEmbed({
    title: 'Automod Rule Updated',
    color: COLORS.success,
    description: [
      `${AUTOMOD_RULE_LABELS[rule]}: ${enabled ? 'enabled' : 'disabled'}`,
      `Punishment: ${patch.rules[rule].punishment || automod.rules[rule].punishment}`,
      'Deleting the message is always attempted for content violations.',
    ].join('\n'),
    footer: ctx.guild.name,
  }));
}

async function setOption(ctx, automod, tokens) {
  const ruleQuery = String(tokens[0] || '').toLowerCase();
  const option = String(tokens[1] || '').toLowerCase();
  const value = tokens[2];

  const rule = AUTOMOD_RULES.find((key) => key === ruleQuery);
  if (!rule) throw new ValidationError(`Unknown rule. Available rules: ${AUTOMOD_RULES.join(', ')}`);

  const bounds = RULE_OPTIONS[rule] || {};
  const bound = bounds[option];

  if (option === 'punishment') {
    const punishment = String(value || '').toLowerCase();
    if (!PUNISHMENTS.includes(punishment)) throw new ValidationError(`Unknown punishment. Options: ${PUNISHMENTS.join(', ')}`);
    await repo('guilds').updateAutomod(ctx.guild.id, { rules: { [rule]: { punishment } } });
    await ctx.replyEmbed(successEmbed({
      title: 'Punishment Updated',
      color: COLORS.success,
      description: `${AUTOMOD_RULE_LABELS[rule]} now applies: ${punishment}`,
      footer: ctx.guild.name,
    }));
    return;
  }

  if (option === 'weight') {
    const weight = Number.parseInt(value, 10);
    if (!Number.isFinite(weight) || weight < 0 || weight > 10) {
      throw new ValidationError('Strike weight must be a number between 0 and 10.');
    }
    await repo('guilds').updateAutomod(ctx.guild.id, { rules: { [rule]: { strikeWeight: weight } } });
    await ctx.replyEmbed(successEmbed({
      title: 'Strike Weight Updated',
      color: COLORS.success,
      description: `${AUTOMOD_RULE_LABELS[rule]} violations now add ${weight} strikes.`,
      footer: ctx.guild.name,
    }));
    return;
  }

  if (!bound) {
    const available = [...Object.keys(bounds), 'punishment', 'weight'];
    throw new ValidationError(`Valid options for ${rule}: ${available.join(', ') || 'none'}. Usage: automod set <rule> <option> <value>`);
  }

  const numeric = Number.parseInt(value, 10);
  if (!Number.isFinite(numeric) || numeric < bound.min || numeric > bound.max) {
    throw new ValidationError(`${option} must be a number between ${bound.min} and ${bound.max}.`);
  }

  await repo('guilds').updateAutomod(ctx.guild.id, { rules: { [rule]: { [option]: numeric } } });

  await ctx.replyEmbed(successEmbed({
    title: 'Automod Option Updated',
    color: COLORS.success,
    description: `${AUTOMOD_RULE_LABELS[rule]} - ${option} set to ${numeric}.`,
    footer: ctx.guild.name,
  }));
}

/* ---------------------------------------------------------------------- words */

async function manageWords(ctx, automod, tokens) {
  const action = String(tokens[0] || 'list').toLowerCase();
  const words = automod.rules.words.words;

  if (action === 'list') {
    await ctx.replyEmbed(baseEmbed({
      title: 'Banned Words',
      color: COLORS.info,
      description: words.length > 0
        ? words.slice(0, 100).map((word, index) => `${index + 1}. ${word}`).join('\n')
        : 'No words are configured. Add one with: automod words add <word>',
      fields: [
        { name: 'State', value: automod.rules.words.enabled ? 'enabled' : 'disabled', inline: true },
        { name: 'Punishment', value: automod.rules.words.punishment, inline: true },
        { name: 'Whole Word Match', value: automod.rules.words.matchWholeWord ? 'yes' : 'no', inline: true },
      ],
      footer: `${ctx.guild.name} | ${words.length} words`,
    }));
    return;
  }

  if (action === 'clear') {
    await repo('guilds').updateAutomod(ctx.guild.id, { rules: { words: { words: [] } } });
    await ctx.replyEmbed(successEmbed({
      title: 'Banned Words Cleared',
      color: COLORS.success,
      description: `Removed ${words.length} entries from the filter list.`,
      footer: ctx.guild.name,
    }));
    return;
  }

  const raw = tokens.slice(1).join(' ');
  const word = sanitizeWord(raw);
  if (!word) throw new ValidationError('Provide a word of at least two characters without symbols.');

  if (action === 'add') {
    if (words.includes(word)) throw new ValidationError('That word is already in the list.');
    await repo('guilds').updateAutomod(ctx.guild.id, { rules: { words: { words: [...words, word] } } });
    await ctx.replyEmbed(successEmbed({
      title: 'Banned Word Added',
      color: COLORS.success,
      description: `The list now contains ${words.length + 1} words. The word itself is not echoed here on purpose.`,
      footer: ctx.guild.name,
    }));
    return;
  }

  if (action === 'remove' || action === 'delete') {
    if (!words.includes(word)) throw new ValidationError('That word is not in the list.');
    await repo('guilds').updateAutomod(ctx.guild.id, { rules: { words: { words: words.filter((entry) => entry !== word) } } });
    await ctx.replyEmbed(successEmbed({
      title: 'Banned Word Removed',
      color: COLORS.success,
      description: `The list now contains ${words.length - 1} words.`,
      footer: ctx.guild.name,
    }));
    return;
  }

  throw new ValidationError('Usage: automod words add|remove|clear|list [word]');
}

/* ---------------------------------------------------------------------- links */

async function manageDomains(ctx, automod, tokens) {
  const action = String(tokens[0] || 'list').toLowerCase();
  const rule = automod.rules.links;

  if (action === 'list') {
    await ctx.replyEmbed(baseEmbed({
      title: 'Link Filter Domains',
      color: COLORS.info,
      fields: [
        { name: 'Allow List', value: rule.allowList.join('\n').slice(0, 1024) || 'Empty', inline: true },
        { name: 'Block List', value: rule.blockList.join('\n').slice(0, 1024) || 'Empty', inline: true },
        { name: 'Behaviour', value: 'When the allow list is not empty, only listed domains are permitted. Blocked domains are always rejected.', inline: false },
      ],
      footer: ctx.guild.name,
    }));
    return;
  }

  if (action === 'clear') {
    const target = String(tokens[1] || '').toLowerCase();
    if (target === 'allow') {
      await repo('guilds').updateAutomod(ctx.guild.id, { rules: { links: { allowList: [] } } });
    } else if (target === 'block') {
      await repo('guilds').updateAutomod(ctx.guild.id, { rules: { links: { blockList: [] } } });
    } else {
      throw new ValidationError('Specify which list to clear: automod links clear allow|block');
    }
    await ctx.replyEmbed(successEmbed({ title: 'Link List Cleared', color: COLORS.success, footer: ctx.guild.name }));
    return;
  }

  const domain = sanitizeDomain(tokens[1]);
  if (!domain) throw new ValidationError('Provide a valid domain, for example example.com.');

  const listName = action === 'allow' ? 'allowList' : action === 'block' ? 'blockList' : null;
  if (!listName) throw new ValidationError('Usage: automod links allow|block|remove|clear|list <domain>');

  if (action === 'remove') {
    const allowList = rule.allowList.filter((entry) => entry !== domain);
    const blockList = rule.blockList.filter((entry) => entry !== domain);
    await repo('guilds').updateAutomod(ctx.guild.id, { rules: { links: { allowList, blockList } } });
    await ctx.replyEmbed(successEmbed({
      title: 'Domain Removed',
      color: COLORS.success,
      description: `${domain} was removed from both lists.`,
      footer: ctx.guild.name,
    }));
    return;
  }

  const current = new Set(rule[listName]);
  current.add(domain);
  const otherList = listName === 'allowList' ? rule.blockList.filter((entry) => entry !== domain) : rule.allowList.filter((entry) => entry !== domain);

  await repo('guilds').updateAutomod(ctx.guild.id, {
    rules: { links: { [listName]: [...current], [listName === 'allowList' ? 'blockList' : 'allowList']: otherList } },
  });

  await ctx.replyEmbed(successEmbed({
    title: action === 'allow' ? 'Domain Allowed' : 'Domain Blocked',
    color: COLORS.success,
    description: `${domain} is now on the ${action === 'allow' ? 'allow' : 'block'} list.`,
    footer: ctx.guild.name,
  }));
}

/* -------------------------------------------------------------------- invites */

async function manageInvites(ctx, automod, tokens) {
  const action = String(tokens[0] || 'list').toLowerCase();
  const rule = automod.rules.invites;

  if (action === 'list') {
    await ctx.replyEmbed(baseEmbed({
      title: 'Invite Filter',
      color: COLORS.info,
      description: rule.allowList.length > 0
        ? `Allowed invite codes:\n${rule.allowList.join('\n').slice(0, 1024)}`
        : 'No invite codes are allowed. Every invite link is removed.',
      fields: [
        { name: 'State', value: rule.enabled ? 'enabled' : 'disabled', inline: true },
        { name: 'Punishment', value: rule.punishment, inline: true },
        { name: 'How To Allow', value: 'The code is the part after discord.gg/. Add it with: automod invites allow <code>', inline: false },
      ],
      footer: ctx.guild.name,
    }));
    return;
  }

  const code = cleanText(tokens[1], 32).toLowerCase();
  if (!code) throw new ValidationError('Provide an invite code, for example: automod invites allow abc123');

  if (action === 'allow') {
    await repo('guilds').updateAutomod(ctx.guild.id, { rules: { invites: { allowList: [...new Set([...rule.allowList, code])] } } });
  } else if (action === 'remove') {
    await repo('guilds').updateAutomod(ctx.guild.id, { rules: { invites: { allowList: rule.allowList.filter((entry) => entry !== code) } } });
  } else {
    throw new ValidationError('Usage: automod invites allow|remove|list <code>');
  }

  await ctx.replyEmbed(successEmbed({
    title: action === 'allow' ? 'Invite Allowed' : 'Invite Removed',
    color: COLORS.success,
    description: `Invite code: ${code}`,
    footer: ctx.guild.name,
  }));
}

/* ----------------------------------------------------------------- escalation */

async function manageEscalation(ctx, automod, tokens) {
  const action = String(tokens[0] || 'show').toLowerCase();
  const escalation = automod.escalation;

  if (action === 'show' || action === 'view') {
    await ctx.replyEmbed(baseEmbed({
      title: 'Escalation Ladder',
      color: COLORS.info,
      description: escalation.steps.length > 0
        ? escalation.steps.map((step) => `${step.strikes} strikes -> ${step.action}${step.duration ? ` for ${step.duration}` : ''}`).join('\n')
        : 'No steps configured. Violations only receive the per-rule punishment.',
      fields: [
        { name: 'State', value: escalation.enabled ? 'enabled' : 'disabled', inline: true },
        { name: 'Window', value: `${escalation.windowHours} hours`, inline: true },
        { name: 'How It Works', value: 'Strikes accumulate inside the window. When a total lands exactly on a step threshold, that step is applied instead of the per-rule punishment.', inline: false },
      ],
      footer: ctx.guild.name,
    }));
    return;
  }

  if (action === 'toggle') {
    await repo('guilds').updateAutomod(ctx.guild.id, { escalation: { enabled: !escalation.enabled } });
    await ctx.replyEmbed(successEmbed({
      title: escalation.enabled ? 'Escalation Disabled' : 'Escalation Enabled',
      color: COLORS.success,
      footer: ctx.guild.name,
    }));
    return;
  }

  if (action === 'window') {
    const hours = Number.parseInt(tokens[1], 10);
    if (!Number.isFinite(hours) || hours < 1 || hours > 720) throw new ValidationError('Provide a window in hours between 1 and 720.');
    await repo('guilds').updateAutomod(ctx.guild.id, { escalation: { windowHours: hours } });
    await ctx.replyEmbed(successEmbed({
      title: 'Escalation Window Updated',
      color: COLORS.success,
      description: `Strikes now expire after ${hours} hours.`,
      footer: ctx.guild.name,
    }));
    return;
  }

  if (action === 'set') {
    const strikes = Number.parseInt(tokens[1], 10);
    const stepAction = String(tokens[2] || '').toLowerCase();
    const durationRaw = tokens[3] || null;

    if (!Number.isFinite(strikes) || strikes < 1 || strikes > 100) throw new ValidationError('Strikes must be between 1 and 100.');
    if (!['warn', 'mute', 'kick', 'ban'].includes(stepAction)) {
      throw new ValidationError('Step action must be one of: warn, mute, kick, ban.');
    }

    let duration = null;
    if (durationRaw) {
      const parsed = parseDuration(durationRaw, { maxMs: 365 * 24 * 60 * 60 * 1000 });
      if (!parsed.ok) throw new ValidationError('That duration could not be read. Use a value such as 30m, 4h, or 3d.');
      duration = durationRaw;
    }

    const steps = escalation.steps.filter((step) => step.strikes !== strikes);
    steps.push({ strikes, action: stepAction, duration });
    steps.sort((a, b) => a.strikes - b.strikes);

    await repo('guilds').updateAutomod(ctx.guild.id, { escalation: { steps } });

    await ctx.replyEmbed(successEmbed({
      title: 'Escalation Step Saved',
      color: COLORS.success,
      description: `${strikes} strikes -> ${stepAction}${duration ? ` for ${formatDuration(parseDuration(duration).ms)}` : ''}`,
      fields: [{ name: 'Ladder', value: steps.map((step) => `${step.strikes} -> ${step.action}`).join('\n'), inline: false }],
      footer: ctx.guild.name,
    }));
    return;
  }

  if (action === 'remove') {
    const strikes = Number.parseInt(tokens[1], 10);
    const steps = escalation.steps.filter((step) => step.strikes !== strikes);
    if (steps.length === escalation.steps.length) throw new ValidationError('No step exists with that strike count.');
    await repo('guilds').updateAutomod(ctx.guild.id, { escalation: { steps } });
    await ctx.replyEmbed(successEmbed({
      title: 'Escalation Step Removed',
      color: COLORS.success,
      description: `The step at ${strikes} strikes was removed.`,
      footer: ctx.guild.name,
    }));
    return;
  }

  throw new ValidationError('Usage: automod escalation show|toggle|window <hours>|set <strikes> <action> [duration]|remove <strikes>');
}

/* ----------------------------------------------------------------------- raid */

async function manageRaid(ctx, automod, tokens) {
  const action = String(tokens[0] || 'show').toLowerCase();
  const raid = automod.raid;

  if (action === 'show' || action === 'view') {
    await ctx.replyEmbed(baseEmbed({
      title: 'Raid Protection',
      color: COLORS.info,
      fields: [
        { name: 'State', value: raid.enabled ? 'enabled' : 'disabled', inline: true },
        { name: 'Threshold', value: `${raid.threshold} joins in ${raid.windowSeconds} seconds`, inline: true },
        { name: 'Action', value: raid.action === 'lockdown' ? 'lock the server' : 'alert staff only', inline: true },
        { name: 'Minimum Account Age', value: `${raid.minAccountAgeDays} days`, inline: true },
        { name: 'Auto Unlock', value: raid.autoUnlockMinutes ? `${raid.autoUnlockMinutes} minutes` : 'disabled', inline: true },
        { name: 'Lockdown Targets', value: `${raid.lockChannelIds.length || 'all text channels'} channels, ${raid.lockRoleIds.length || '@everyone'} roles`, inline: false },
      ],
      footer: ctx.guild.name,
    }));
    return;
  }

  if (action === 'enable' || action === 'disable') {
    await repo('guilds').updateAutomod(ctx.guild.id, { raid: { enabled: action === 'enable' } });
    await ctx.replyEmbed(successEmbed({
      title: action === 'enable' ? 'Raid Protection Enabled' : 'Raid Protection Disabled',
      color: COLORS.success,
      footer: ctx.guild.name,
    }));
    return;
  }

  if (action === 'threshold') {
    const value = Number.parseInt(tokens[1], 10);
    if (!Number.isFinite(value) || value < 2 || value > 200) throw new ValidationError('Threshold must be between 2 and 200 joins.');
    await repo('guilds').updateAutomod(ctx.guild.id, { raid: { threshold: value } });
    await ctx.replyEmbed(successEmbed({
      title: 'Raid Threshold Updated',
      color: COLORS.success,
      description: `${value} joins inside ${raid.windowSeconds} seconds triggers raid protection.`,
      footer: ctx.guild.name,
    }));
    return;
  }

  if (action === 'window') {
    const value = Number.parseInt(tokens[1], 10);
    if (!Number.isFinite(value) || value < 5 || value > 600) throw new ValidationError('Window must be between 5 and 600 seconds.');
    await repo('guilds').updateAutomod(ctx.guild.id, { raid: { windowSeconds: value } });
    await ctx.replyEmbed(successEmbed({
      title: 'Raid Window Updated',
      color: COLORS.success,
      description: `Joins are counted over ${value} seconds.`,
      footer: ctx.guild.name,
    }));
    return;
  }

  if (action === 'account-age') {
    const value = Number.parseInt(tokens[1], 10);
    if (!Number.isFinite(value) || value < 0 || value > 365) throw new ValidationError('Account age must be between 0 and 365 days.');
    await repo('guilds').updateAutomod(ctx.guild.id, { raid: { minAccountAgeDays: value } });
    await ctx.replyEmbed(successEmbed({
      title: 'Account Age Threshold Updated',
      color: COLORS.success,
      description: `Accounts younger than ${value} days are highlighted in raid alerts.`,
      footer: ctx.guild.name,
    }));
    return;
  }

  if (action === 'action') {
    const value = String(tokens[1] || '').toLowerCase();
    if (!['alert', 'lockdown'].includes(value)) throw new ValidationError('Action must be alert or lockdown.');
    await repo('guilds').updateAutomod(ctx.guild.id, { raid: { action: value } });
    await ctx.replyEmbed(successEmbed({
      title: 'Raid Action Updated',
      color: COLORS.success,
      description: value === 'lockdown'
        ? 'The server will be locked down automatically when a raid is detected.'
        : 'Staff will be alerted; no channels are changed automatically.',
      footer: ctx.guild.name,
    }));
    return;
  }

  if (action === 'auto-unlock') {
    const value = Number.parseInt(tokens[1], 10);
    if (!Number.isFinite(value) || value < 0 || value > 10080) throw new ValidationError('Auto unlock must be between 0 and 10080 minutes. Use 0 to disable.');
    await repo('guilds').updateAutomod(ctx.guild.id, { raid: { autoUnlockMinutes: value } });
    await ctx.replyEmbed(successEmbed({
      title: 'Auto Unlock Updated',
      color: COLORS.success,
      description: value === 0 ? 'Automatic unlock disabled.' : `The server unlocks ${value} minutes after an automatic lockdown.`,
      footer: ctx.guild.name,
    }));
    return;
  }

  if (action === 'channels') {
    const target = String(tokens[1] || '').toLowerCase();
    if (target === 'clear') {
      await repo('guilds').updateAutomod(ctx.guild.id, { raid: { lockChannelIds: [] } });
      await ctx.replyEmbed(successEmbed({ title: 'Raid Lockdown Channels Cleared', color: COLORS.success, description: 'All text channels will be locked during a raid.', footer: ctx.guild.name }));
      return;
    }
    const channel = await ctx.resolveChannel(tokens[1]);
    if (!channel) throw new ValidationError('That channel could not be found.');
    const list = raid.lockChannelIds.includes(channel.id)
      ? raid.lockChannelIds.filter((id) => id !== channel.id)
      : [...raid.lockChannelIds, channel.id];
    await repo('guilds').updateAutomod(ctx.guild.id, { raid: { lockChannelIds: list } });
    await ctx.replyEmbed(successEmbed({
      title: 'Raid Lockdown Channels Updated',
      color: COLORS.success,
      description: list.length > 0 ? list.map((id) => `<#${id}>`).join(', ') : 'No channels listed; all text channels will be locked.',
      footer: ctx.guild.name,
    }));
    return;
  }

  if (action === 'roles') {
    const target = String(tokens[1] || '').toLowerCase();
    if (target === 'clear') {
      await repo('guilds').updateAutomod(ctx.guild.id, { raid: { lockRoleIds: [] } });
      await ctx.replyEmbed(successEmbed({ title: 'Raid Lockdown Roles Cleared', color: COLORS.success, description: 'Only the default role will be denied send permission.', footer: ctx.guild.name }));
      return;
    }
    const role = await ctx.resolveRole(tokens[1]);
    if (!role) throw new ValidationError('That role could not be found.');
    const list = raid.lockRoleIds.includes(role.id)
      ? raid.lockRoleIds.filter((id) => id !== role.id)
      : [...raid.lockRoleIds, role.id];
    await repo('guilds').updateAutomod(ctx.guild.id, { raid: { lockRoleIds: list } });
    await ctx.replyEmbed(successEmbed({
      title: 'Raid Lockdown Roles Updated',
      color: COLORS.success,
      description: list.length > 0 ? list.map((id) => `<@&${id}>`).join(', ') : 'Only the default role will be denied send permission.',
      footer: ctx.guild.name,
    }));
    return;
  }

  throw new ValidationError('Usage: automod raid show|enable|disable|threshold|window|action|account-age|auto-unlock|channels|roles');
}

/* ----------------------------------------------------------------- exemptions */

async function manageExemption(ctx, automod, tokens) {
  const kind = String(tokens[0] || '').toLowerCase();
  const action = String(tokens[1] || '').toLowerCase();
  const query = tokens[2];

  if (!['role', 'channel'].includes(kind) || !['add', 'remove'].includes(action) || !query) {
    throw new ValidationError('Usage: automod exemption role|channel add|remove <role or channel>');
  }

  if (kind === 'role') {
    const role = await ctx.resolveRole(query);
    if (!role) throw new ValidationError('That role could not be found.');
    const current = new Set(automod.exemptions.roleIds);
    if (action === 'add') current.add(role.id);
    else current.delete(role.id);
    await repo('guilds').updateAutomod(ctx.guild.id, { exemptions: { roleIds: [...current] } });
    await ctx.replyEmbed(successEmbed({
      title: 'Automod Exemptions Updated',
      color: COLORS.success,
      description: `${role.name} is now ${action === 'add' ? 'exempt from' : 'no longer exempt from'} automod.`,
      footer: ctx.guild.name,
    }));
    return;
  }

  const channel = await ctx.resolveChannel(query);
  if (!channel) throw new ValidationError('That channel could not be found.');
  const current = new Set(automod.exemptions.channelIds);
  if (action === 'add') current.add(channel.id);
  else current.delete(channel.id);
  await repo('guilds').updateAutomod(ctx.guild.id, { exemptions: { channelIds: [...current] } });
  await ctx.replyEmbed(successEmbed({
    title: 'Automod Exemptions Updated',
    color: COLORS.success,
    description: `<#${channel.id}> is now ${action === 'add' ? 'exempt from' : 'no longer exempt from'} automod.`,
    footer: ctx.guild.name,
  }));
}

/* -------------------------------------------------------------------- strikes */

async function manageStrikes(ctx, automod, tokens) {
  const first = String(tokens[0] || '').toLowerCase();

  if (first === 'reset') {
    const target = await ctx.resolveMember(tokens[1]);
    if (!target) throw new ValidationError('Provide a member whose strikes should be reset.');
    const removed = await repo('punishments').resetStrikes(ctx.guild.id, target.id);
    await ctx.replyEmbed(successEmbed({
      title: 'Strikes Reset',
      color: COLORS.success,
      description: `Removed ${removed} strike record${removed === 1 ? '' : 's'} for ${target.user.tag}.`,
      fields: [{ name: 'Moderator', value: `<@${ctx.author.id}>`, inline: true }],
      footer: ctx.guild.name,
    }));
    return;
  }

  const target = first ? await ctx.resolveMember(tokens[0]) : null;
  if (!target) {
    const user = await ctx.resolveUser(first);
    if (!user) throw new ValidationError('Provide a member to inspect, or use: automod strikes reset <member>');
    const strikes = await repo('punishments').getStrikes(ctx.guild.id, user.id);
    await ctx.replyEmbed(baseEmbed({
      title: `Automod Strikes: ${user.tag}`,
      color: COLORS.info,
      fields: [
        { name: 'Active Strikes', value: String(strikes), inline: true },
        { name: 'Window', value: `${automod.escalation.windowHours} hours`, inline: true },
      ],
      footer: ctx.guild.name,
    }));
    return;
  }

  const strikes = await repo('punishments').getStrikes(ctx.guild.id, target.id);
  const nextStep = automod.escalation.steps.find((step) => step.strikes > strikes);

  await ctx.replyEmbed(baseEmbed({
    title: `Automod Strikes: ${target.user.tag}`,
    color: COLORS.info,
    fields: [
      { name: 'Active Strikes', value: String(strikes), inline: true },
      { name: 'Window', value: `${automod.escalation.windowHours} hours`, inline: true },
      { name: 'Next Step', value: nextStep ? `${nextStep.strikes} strikes -> ${nextStep.action}` : 'No further steps configured', inline: true },
    ],
    footer: ctx.guild.name,
  }));
}
