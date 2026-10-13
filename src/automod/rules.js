'use strict';

/**
 * Automod rule evaluation.
 *
 * Scope note: this module inspects message *content* only (invites, links,
 * words, caps, mentions, emoji density). It deliberately does not implement
 * flood or rate detection: the escalating strike system plus moderation
 * actions is the intended enforcement path for repeat behaviour.
 *
 * Each rule is a pure function returning a violation object or null, which
 * keeps evaluation testable and keeps the side effects (deleting a message,
 * recording a strike, applying a punishment) in the service layer.
 */

/** Matches discord.gg / discord.com/invite links and bare invite codes in URLs. */
const INVITE_PATTERN = /(?:https?:\/\/)?(?:www\.)?(?:discord(?:app)?\.(?:gg|com|me)\/(?:invite\/)?|dsc\.gg\/|invite\.gg\/)([a-zA-Z0-9-]{2,32})/gi;

/** Matches any http(s) URL or bare domain-like token. */
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"']+|(?<![\w.@-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,24})(?:\/[^\s<>"']*)?/gi;

/** Custom emoji, unicode emoji blocks, and Twemoji-style surrogates. */
const CUSTOM_EMOJI_PATTERN = /<a?:\w{1,32}:\d{15,25}>/g;
// Unicode emoji ranges kept in one expression: symbols, pictographs, transport,
// supplemental symbols, and variation selectors.
const UNICODE_EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu;

/**
 * Count uppercase letters and total letters in a string.
 * @param {string} content
 */
function capsRatio(content) {
  const letters = content.replace(/[^\p{L}]/gu, '');
  if (letters.length === 0) return { ratio: 0, letters: 0 };
  const upper = letters.replace(/[^\p{Lu}]/gu, '').length;
  return { ratio: upper / letters.length, letters: letters.length };
}

/** Extract the registrable hostname of a URL-ish string. */
function hostnameOf(candidate) {
  try {
    const normalized = candidate.startsWith('http') ? candidate : `http://${candidate}`;
    const url = new URL(normalized);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** True when the hostname equals or is a subdomain of an entry. */
function hostMatches(hostname, entry) {
  if (!hostname || !entry) return false;
  const normalized = String(entry).toLowerCase().replace(/^www\./, '');
  return hostname === normalized || hostname.endsWith(`.${normalized}`);
}

/** Whole-word aware search for a banned phrase. */
function containsWord(content, word, wholeWord) {
  if (!word) return false;
  if (!wholeWord) return content.includes(word);
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Word boundaries that also treat digits and underscores as word characters.
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`, 'iu');
  return pattern.test(content);
}

/**
 * Evaluate one rule.
 *
 * @param {string} rule rule key
 * @param {object} context
 * @param {string} context.content raw message content
 * @param {import('discord.js').Message} context.message
 * @param {object} context.ruleConfig per-rule configuration
 * @param {object} context.automod full automod configuration document
 * @returns {{rule: string, detail: string, matched: string[]}|null}
 */
function evaluateRule(rule, context) {
  const { content, message, ruleConfig } = context;

  switch (rule) {
    case 'invites': {
      // The allow list holds invite codes (and any values that appear verbatim
      // in the message). Codes are verified without an API call, so a server
      // that wants its own invite permitted adds the code shown by Discord.
      const allowList = (Array.isArray(ruleConfig.allowList) ? ruleConfig.allowList : [])
        .map((entry) => String(entry).trim().toLowerCase())
        .filter(Boolean);

      const matches = content.match(INVITE_PATTERN);
      if (!matches) return null;

      const codes = matches.map((match) => String(match).split('/').pop()).filter(Boolean);
      const offenders = codes.filter((code) => !allowList.includes(String(code).toLowerCase()));
      if (offenders.length === 0) return null;

      return { rule, detail: 'Discord invite link', matched: offenders.slice(0, 10) };
    }

    case 'links': {
      const candidates = content.match(URL_PATTERN);
      if (!candidates) return null;

      const allowList = Array.isArray(ruleConfig.allowList) ? ruleConfig.allowList : [];
      const blockList = Array.isArray(ruleConfig.blockList) ? ruleConfig.blockList : [];

      const offenders = [];
      for (const candidate of candidates) {
        const hostname = hostnameOf(candidate);
        if (!hostname) continue;
        if (blockList.some((entry) => hostMatches(hostname, entry))) {
          offenders.push(hostname);
          continue;
        }
        if (allowList.length > 0 && !allowList.some((entry) => hostMatches(hostname, entry))) {
          offenders.push(hostname);
        }
      }
      if (offenders.length === 0) return null;
      return { rule, detail: 'Link outside the allow list', matched: [...new Set(offenders)].slice(0, 10) };
    }

    case 'words': {
      const words = Array.isArray(ruleConfig.words) ? ruleConfig.words : [];
      if (words.length === 0) return null;

      const allowList = Array.isArray(ruleConfig.allowList) ? ruleConfig.allowList : [];
      const wholeWord = ruleConfig.matchWholeWord !== false;
      const evidence = [];
      let lowestIndex = Number.MAX_SAFE_INTEGER;

      for (const word of words) {
        if (!word) continue;
        if (allowList.includes(word)) continue;
        const index = wholeWord ? firstWordIndex(content, word) : content.toLowerCase().indexOf(word);
        if (index === -1) continue;
        evidence.push(word);
        lowestIndex = Math.min(lowestIndex, index);
      }

      if (evidence.length === 0) return null;
      // The matched words are reported to staff in the log, and to the message
      // author only as a rule name: the filter list itself stays private.
      return { rule, detail: 'Banned word', matched: evidence.slice(0, 5) };
    }

    case 'caps': {
      const minLength = Number.isFinite(ruleConfig.minLength) ? ruleConfig.minLength : 12;
      const threshold = Number.isFinite(ruleConfig.thresholdPercent) ? ruleConfig.thresholdPercent : 70;
      const { ratio, letters } = capsRatio(content);
      if (letters < minLength) return null;
      if (ratio * 100 < threshold) return null;
      return { rule, detail: `Excessive capitals (${Math.round(ratio * 100)} percent)`, matched: [] };
    }

    case 'mentions': {
      const maxMentions = Number.isFinite(ruleConfig.maxMentions) ? ruleConfig.maxMentions : 6;
      const includeRoles = Boolean(ruleConfig.includeRoleMentions);
      const users = message.mentions ? message.mentions.users.size : 0;
      const roles = includeRoles && message.mentions ? message.mentions.roles.size : 0;
      const total = users + roles;
      if (total <= maxMentions) return null;
      return { rule, detail: `Mass mention (${total} mentions)`, matched: [] };
    }

    case 'emoji': {
      const maxEmoji = Number.isFinite(ruleConfig.maxEmoji) ? ruleConfig.maxEmoji : 8;
      const threshold = Number.isFinite(ruleConfig.thresholdPercent) ? ruleConfig.thresholdPercent : 40;

      const custom = content.match(CUSTOM_EMOJI_PATTERN) || [];
      const withoutCustom = content.replace(CUSTOM_EMOJI_PATTERN, ' ');
      const unicode = withoutCustom.match(UNICODE_EMOJI_PATTERN) || [];
      const total = custom.length + unicode.length;
      if (total === 0) return null;

      const visibleLength = withoutCustom.replace(UNICODE_EMOJI_PATTERN, '').trim().length;
      const density = (total / Math.max(1, total + visibleLength)) * 100;

      if (total > maxEmoji || density > threshold) {
        return { rule, detail: `Emoji spam (${total} emoji)`, matched: [] };
      }
      return null;
    }

    default:
      return null;
  }
}

/** Index of the first whole-word occurrence, or -1. */
function firstWordIndex(content, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])(${escaped})(?=[^\\p{L}\\p{N}_]|$)`, 'iu');
  const match = pattern.exec(content);
  if (!match) return -1;
  return match.index + (match[1] ? match[1].length : 0);
}

/**
 * Remove invite and link fragments from a message so the log entry can show
 * the offending content without broadcasting a working invite.
 * @param {string} content
 * @returns {string}
 */
function redactLinks(content) {
  return String(content || '')
    .replace(INVITE_PATTERN, '[invite link removed]')
    .replace(URL_PATTERN, (match) => {
      const hostname = hostnameOf(match);
      return hostname ? `[link: ${hostname}]` : '[link removed]';
    });
}

module.exports = {
  evaluateRule,
  capsRatio,
  hostnameOf,
  hostMatches,
  containsWord,
  redactLinks,
  INVITE_PATTERN,
  URL_PATTERN,
  CUSTOM_EMOJI_PATTERN,
  UNICODE_EMOJI_PATTERN,
};
