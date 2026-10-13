'use strict';

/**
 * Offline self test.
 *
 * Validates the parts of the bot that can be exercised without a Discord
 * connection or a live Cloudflare deployment:
 *
 *   1. Command registry: every command module loads and is well formed.
 *   2. Configuration integrity: log events, channel slots, and actions align.
 *   3. Permission mapping: every command action has a bot permission entry.
 *   4. Utilities: duration parsing, sanitization, embed building, redaction.
 *   5. Automod rules: representative violations are detected.
 *   6. Gateway worker: routing, authentication, and validation behaviour.
 *
 * No network access is performed and no secrets are required.
 *
 * Usage: npm run selftest
 */

const path = require('path');

const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
const failures = [];

/** Assert a condition, recording the outcome. */
function check(name, condition, details) {
  if (condition) {
    passed += 1;
    return true;
  }
  failed += 1;
  failures.push(`${name}${details ? ` - ${details}` : ''}`);
  return false;
}

function section(title) {
  console.log(`\n${title}`);
}

async function main() {
  /* ------------------------------------------------------ module loading */
  section('Module integrity');

  {
    const fs = require('fs');
    const modules = [];
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) modules.push(full);
      }
    };
    walk(path.join(ROOT, 'src'));

    for (const file of modules) {
      try {
        // eslint-disable-next-line global-require, import/no-dynamic-require
        require(file);
        check(`module loads: ${path.relative(ROOT, file)}`, true);
      } catch (error) {
        check(`module loads: ${path.relative(ROOT, file)}`, false, error && error.message);
      }
    }
  }

  /* ------------------------------------------------------------ registry */
  section('Command registry');

  const registry = require(path.join(ROOT, 'src/core/registry.js'));
  const count = registry.loadDirectory(path.join(ROOT, 'src/commands'));
  check('commands load', count > 0, `loaded ${count}`);
  check('no duplicate names', registry.stats().commands === count, `${count} loaded, ${registry.stats().commands} unique`);

  for (const command of registry.all()) {
    check(`"${command.name}" has execute`, typeof command.execute === 'function');
    check(`"${command.name}" has description`, typeof command.description === 'string' && command.description.length > 5);
    check(`"${command.name}" has usage`, typeof command.usage === 'string' && command.usage.includes(command.name));
    for (const option of command.slashOptions || []) {
      check(
        `"${command.name}" slash option "${option.name}" is typed`,
        ['user', 'member', 'channel', 'role', 'integer', 'boolean', 'string'].includes(option.type || 'string'),
      );
    }
  }

  /* ------------------------------------------------------- configuration */
  section('Configuration integrity');

  const constants = require(path.join(ROOT, 'src/config/constants.js'));
  const defaults = require(path.join(ROOT, 'src/config/defaults.js'));

  for (const [key, meta] of Object.entries(constants.LOG_EVENTS)) {
    check(`log event "${key}" has a default channel slot`, Boolean(constants.LOG_CHANNEL_SLOTS[meta.defaultChannel]));
    check(`log event "${key}" belongs to a known category`, Boolean(constants.LOG_CATEGORIES[meta.category]));
  }

  const defaultEvents = defaults.buildDefaultLogEvents();
  check(
    'default log events cover every event',
    Object.keys(defaultEvents).length === Object.keys(constants.LOG_EVENTS).length,
  );

  const defaultAutomod = defaults.defaultAutomodConfig();
  for (const rule of constants.AUTOMOD_RULES) {
    check(`automod default for "${rule}" exists`, Boolean(defaultAutomod.rules[rule]));
  }
  check('automod escalation ladder is ordered', defaultAutomod.escalation.steps
    .every((step, index, array) => index === 0 || array[index - 1].strikes < step.strikes));

  /* ---------------------------------------------------------- permissions */
  section('Permission mapping');

  const permissionService = require(path.join(ROOT, 'src/services/permissionService.js'));
  const levelWeights = constants.LEVEL_WEIGHT;

  for (const command of registry.all()) {
    check(
      `"${command.name}" declares a known permission level`,
      Object.prototype.hasOwnProperty.call(levelWeights, command.permission),
      command.permission,
    );
    if (command.action) {
      check(
        `"${command.name}" action "${command.action}" has a bot permission entry`,
        Object.prototype.hasOwnProperty.call(permissionService.REQUIRED_BOT_PERMISSIONS, command.action),
        command.action,
      );
    }
  }

  /* ------------------------------------------------------------ utilities */
  section('Utilities');

  const duration = require(path.join(ROOT, 'src/utils/duration.js'));
  check('parses 30m', duration.parseDuration('30m').ms === 30 * 60 * 1000);
  check('parses 1d 2h', duration.parseDuration('1d 2h').ms === 26 * 60 * 60 * 1000);
  check('rejects unknown unit', duration.parseDuration('5 lightyears').ok === false);
  check('formats 1d 2h 3m', duration.formatDuration(26 * 60 * 60 * 1000 + 3 * 60 * 1000) === '1d 2h 3m');

  const sanitize = require(path.join(ROOT, 'src/utils/sanitize.js'));
  check('strips @everyone', sanitize.sanitizeReason('@everyone raid now').includes('@ everyone'));
  check('strips user mentions', !sanitize.sanitizeReason('<@123456789012345678> bad').includes('<@'));
  check('removes control characters', sanitize.cleanText('a\u0000b\u200Bc') === 'abc');
  check('clamps integers', sanitize.clampInt('999', 0, 10) === 10);
  check('accepts a valid prefix', sanitize.sanitizePrefix('?') === '?');
  check('rejects a prefix with spaces or mentions', sanitize.sanitizePrefix('a b') === 'ab' && sanitize.sanitizePrefix('@') === null);
  check('validates domains', sanitize.sanitizeDomain('https://www.Example.com/path') === 'example.com');
  check('rejects invalid domains', sanitize.sanitizeDomain('not a domain') === null);

  const embeds = require(path.join(ROOT, 'src/utils/embeds.js'));
  const moderationEmbed = embeds.moderationEmbed({
    action: 'ban',
    target: { id: '123456789012345678', user: { username: 'target', id: '123456789012345678' } },
    moderator: { id: '223456789012345678', user: { username: 'moderator', id: '223456789012345678' } },
    reason: 'Test reason',
    caseId: 42,
    durationMs: 3600000,
    guildName: 'Test Guild',
  });
  check('moderation embed has a title', typeof moderationEmbed.title === 'string' && moderationEmbed.title.length > 0);
  check('moderation embed is color coded', Number.isInteger(moderationEmbed.color));
  check('moderation embed carries a case id field', moderationEmbed.fields.some((field) => field.name === 'Case ID'));
  check('moderation embed carries a footer', Boolean(moderationEmbed.footer && moderationEmbed.footer.text.includes('42')));

  const longFieldEmbed = embeds.baseEmbed({
    title: 'x'.repeat(1000),
    description: 'y'.repeat(9000),
    fields: [{ name: 'n', value: 'v'.repeat(5000) }],
  });
  check('embed title is truncated', longFieldEmbed.title.length <= constants.EMBED_LIMITS.title);
  check('embed description is truncated', longFieldEmbed.description.length <= constants.EMBED_LIMITS.description);
  check('embed field value is truncated', longFieldEmbed.fields[0].value.length <= constants.EMBED_LIMITS.fieldValue);

  const loggerModule = require(path.join(ROOT, 'src/utils/logger.js'));
  const fakeToken = 'fake-token-for-offline-tests.not-a-real-credential.x';
  loggerModule.logger.registerSecret(fakeToken);
  const redacted = loggerModule.logger.redact(`token is ${fakeToken} end`);
  check('logger redacts registered secrets', !redacted.includes(fakeToken) && redacted.includes('[redacted]'));
  const redactedObject = loggerModule.logger.redactValue({ token: 'value', apiKey: 'value2', safe: 'keep' });
  check('logger redacts sensitive keys', redactedObject.token === '[redacted]' && redactedObject.apiKey === '[redacted]' && redactedObject.safe === 'keep');

  const parser = require(path.join(ROOT, 'src/utils/parser.js'));
  check('tokenizes quoted arguments', parser.tokenize('one "two three" four').length === 3);
  const flagResult = parser.extractFlags(parser.tokenize('50 --user=@me --bots reason'));
  check('extracts flags', flagResult.flags.user === '@me' && flagResult.flags.bots === true && flagResult.args.length === 2);

  /* ------------------------------------------------------------- automod */
  section('Automod rules');

  const rules = require(path.join(ROOT, 'src/automod/rules.js'));
  const fakeMessage = {
    mentions: { users: new Map([['1', { id: '1' }], ['2', { id: '2' }], ['3', { id: '3' }]]), roles: new Map() },
    channel: { id: '1' },
  };

  check('detects invite links', Boolean(rules.evaluateRule('invites', {
    content: 'join us https://discord.gg/abcdef', message: fakeMessage, ruleConfig: { allowList: [] },
  })));

  check('allows whitelisted invite codes', rules.evaluateRule('invites', {
    content: 'join us https://discord.gg/abcdef', message: fakeMessage, ruleConfig: { allowList: ['abcdef'] },
  }) === null);

  check('flags domains outside the allow list', Boolean(rules.evaluateRule('links', {
    content: 'see https://example.org/x', message: fakeMessage, ruleConfig: { allowList: ['youtube.com'], blockList: [] },
  })));

  check('permits allowed domains', rules.evaluateRule('links', {
    content: 'see https://www.youtube.com/watch?v=1', message: fakeMessage, ruleConfig: { allowList: ['youtube.com'], blockList: [] },
  }) === null);

  check('detects banned words as whole words', Boolean(rules.evaluateRule('words', {
    content: 'this is badword here', message: fakeMessage, ruleConfig: { words: ['badword'], allowList: [], matchWholeWord: true },
  })));

  check('does not match inside larger words', rules.evaluateRule('words', {
    content: 'this is badwordsmith here', message: fakeMessage, ruleConfig: { words: ['badword'], allowList: [], matchWholeWord: true },
  }) === null);

  check('detects excessive caps', Boolean(rules.evaluateRule('caps', {
    content: 'THIS IS ENTIRELY TOO LOUD', message: fakeMessage, ruleConfig: { minLength: 12, thresholdPercent: 70 },
  })));

  check('detects mass mentions', Boolean(rules.evaluateRule('mentions', {
    content: 'hi', message: fakeMessage, ruleConfig: { maxMentions: 2, includeRoleMentions: false },
  })));

  check('detects emoji spam', Boolean(rules.evaluateRule('emoji', {
    content: '<:x:123456789012345678> 12345', message: fakeMessage, ruleConfig: { maxEmoji: 0, thresholdPercent: 100 },
  })));

  /* --------------------------------------------------------- worker routes */
  section('Gateway worker');

  try {
    const worker = (await import(`file://${path.join(ROOT, 'cloudflare/worker/src/index.js')}`)).default;

    /** Minimal D1 stand-in: returns canned rows keyed by the SQL shape. */
    const fakeEnv = (overrides = {}) => ({
      WORKER_AUTH_TOKEN: 'test-token-value-that-is-long-enough',
      RATE_LIMIT_PER_MINUTE: '600',
      CONFIG_CACHE_SECONDS: '0',
      MAX_BODY_BYTES: '262144',
      DB: {
        prepare(sql) {
          return {
            bind(...params) {
              return {
                async first() {
                  if (/FROM guilds WHERE guild_id = \?1/i.test(sql) && /created_at/.test(sql)) {
                    return {
                      guild_id: params[0],
                      guild_name: 'Test Guild',
                      prefix: '!',
                      prefix_enabled: 1,
                      slash_enabled: 0,
                      mod_role_ids: '[]',
                      admin_role_ids: '[]',
                      trusted_role_ids: '[]',
                      muted_role_id: null,
                      mute_role_enabled: 0,
                      require_reason: 1,
                      dm_on_punishment: 1,
                      delete_command_msgs: 0,
                      lockdown_config: '{}',
                      misc_config: '{}',
                      created_at: 1,
                      updated_at: 1,
                    };
                  }
                  if (/SELECT guild_id FROM guilds/i.test(sql)) return { guild_id: params[0] };
                  if (/SELECT 1 AS value/i.test(sql)) return { value: 1 };
                  return null;
                },
                async all() {
                  if (/FROM scheduled_tasks/i.test(sql)) return { results: [] };
                  return { results: [] };
                },
                async run() {
                  return { meta: { last_row_id: 1, changes: 1 } };
                },
              };
            },
          };
        },
        async batch(statements) {
          return statements.map(() => ({ meta: { last_row_id: 1, changes: 1 } }));
        },
      },
      ...overrides,
    });

    const call = async (path_, options = {}) => worker.fetch(
      new Request(`https://gateway.example/${path_.replace(/^\//, '')}`, options),
      options.env || fakeEnv(),
      {},
    );

    const health = await call('health');
    check('public health endpoint responds 200', health.status === 200);

    const unauthorized = await call('v1/guilds/123456789012345678/config');
    check('unauthenticated request is rejected', unauthorized.status === 401);

    const authorized = await call('v1/guilds/123456789012345678/config', {
      headers: { Authorization: 'Bearer test-token-value-that-is-long-enough' },
    });
    check('authorized configuration read succeeds', authorized.status === 200);
    const body = await authorized.json();
    check('configuration payload is shaped correctly', body.ok === true && body.config && body.config.prefixEnabled === true);

    const badId = await call('v1/guilds/not-an-id/config', {
      headers: { Authorization: 'Bearer test-token-value-that-is-long-enough' },
    });
    check('malformed identifier is rejected', badId.status === 404 || badId.status === 422);

    const wrongMethod = await call('v1/guilds/123456789012345678/config', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-token-value-that-is-long-enough' },
    });
    check('unsupported method is rejected', wrongMethod.status === 405);

    const unknownRoute = await call('v1/nothing/here', {
      headers: { Authorization: 'Bearer test-token-value-that-is-long-enough' },
    });
    check('unknown route returns 404', unknownRoute.status === 404);

    const badBody = await call('v1/guilds/123456789012345678/cases', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token-value-that-is-long-enough', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'teleport' }),
    });
    check('invalid enum value is rejected', badBody.status === 422);

    const missingContentType = await call('v1/guilds/123456789012345678/cases', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token-value-that-is-long-enough' },
      body: '{}',
    });
    check('missing content type is rejected', missingContentType.status === 400);
  } catch (error) {
    check('worker module loads', false, error && error.message);
  }

  /* ------------------------------------------------------------- reporting */
  section('Result');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    console.log('\nFailures:');
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }

  console.log('\nAll checks passed.');
}

main().catch((error) => {
  console.error('Self test crashed:', error && error.message);
  console.error(error && error.stack);
  process.exit(1);
});
