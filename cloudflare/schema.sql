-- ============================================================================
-- Discord moderation bot - Cloudflare D1 schema
--
-- Apply with:
--   npx wrangler d1 execute <DATABASE_NAME> --remote --file=../schema.sql
--   (run from cloudflare/worker/, or use the npm scripts in package.json)
--
-- Conventions:
--   * Discord snowflakes are stored as TEXT so they round-trip exactly; they
--     exceed the safe integer range for JavaScript numbers.
--   * Timestamps are INTEGER Unix epoch milliseconds, always UTC.
--   * Per-guild case numbers are allocated from guild_counters inside a single
--     statement so two concurrent actions can never share a case number.
--   * Nested configuration (log routing, automod rules) is stored as JSON text.
--     The Worker validates and normalizes the JSON before it is written, and
--     every scalar filter (prefix, flags) also has its own column.
--   * Every statement is idempotent: re-running the file is safe.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ----------------------------------------------------------------------------
-- Guilds: one row per Discord server the bot is in.
-- Holds the top-level configuration: prefix behaviour, authorization roles,
-- mute role, behaviour flags, lockdown defaults, and log channel routing.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guilds (
  guild_id            TEXT PRIMARY KEY,
  guild_name          TEXT,

  -- Command handling
  prefix              TEXT,                       -- NULL means "use DEFAULT_PREFIX from the bot environment"
  prefix_enabled      INTEGER NOT NULL DEFAULT 0,
  slash_enabled       INTEGER NOT NULL DEFAULT 1,

  -- Authorization role lists (JSON arrays of snowflake strings)
  mod_role_ids        TEXT NOT NULL DEFAULT '[]',
  admin_role_ids      TEXT NOT NULL DEFAULT '[]',
  trusted_role_ids    TEXT NOT NULL DEFAULT '[]',

  -- Muting
  muted_role_id       TEXT,
  mute_role_enabled   INTEGER NOT NULL DEFAULT 0,

  -- Behaviour
  require_reason      INTEGER NOT NULL DEFAULT 1,
  dm_on_punishment    INTEGER NOT NULL DEFAULT 1,
  delete_command_msgs INTEGER NOT NULL DEFAULT 0,

  -- Lockdown defaults
  lockdown_config     TEXT NOT NULL DEFAULT '{}',
  -- Extensible per-guild flags: nickname locks, feature toggles, and other
  -- small state that does not warrant its own column.
  misc_config         TEXT NOT NULL DEFAULT '{}',

  -- Diagnostics
  configured_at       INTEGER,
  configured_by       TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- ----------------------------------------------------------------------------
-- Guild counters: monotonic sequences. One row per guild per counter type.
-- The case counter is incremented with INSERT .. ON CONFLICT .. RETURNING so
-- case numbers stay unique and gap-free under concurrency.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guild_counters (
  guild_id     TEXT NOT NULL,
  counter      TEXT NOT NULL,                     -- 'case'
  last_value   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, counter)
);

-- ----------------------------------------------------------------------------
-- Cases: the moderation record. One row per action, including reversals.
-- case_number is the per-guild, human facing identifier shown in embeds.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cases (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id        TEXT NOT NULL,
  case_number     INTEGER NOT NULL,

  action          TEXT NOT NULL,                  -- ban, tempban, kick, mute, warn, note, ...
  status          TEXT NOT NULL DEFAULT 'active', -- active | reversed | expired | completed

  target_id       TEXT,                           -- subject of the action (NULL for channel-wide actions)
  moderator_id    TEXT NOT NULL,                  -- who issued it ('system' for automod and expiries)
  reason          TEXT,
  evidence_url    TEXT,

  duration_ms     INTEGER,                        -- requested duration for timed actions
  expires_at      INTEGER,                        -- epoch ms when the punishment ends
  warning_id      INTEGER,                        -- set when the case originated from a warning

  channel_id      TEXT,                           -- channel the action was applied in (purge, lockdown, ...)
  metadata        TEXT NOT NULL DEFAULT '{}',     -- JSON: extra details (counts, roles, automod rule, ...)

  reversed_at     INTEGER,
  reversed_by     TEXT,

  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cases_guild_number ON cases (guild_id, case_number);
CREATE INDEX IF NOT EXISTS idx_cases_target ON cases (guild_id, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cases_moderator ON cases (guild_id, moderator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cases_action ON cases (guild_id, action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cases_active ON cases (guild_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_cases_created ON cases (guild_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- Warnings: individual, clearable, optionally expiring warnings.
-- A warning also produces a case row (action = 'warn') and links via warning_id.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS warnings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id      TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  moderator_id  TEXT NOT NULL,
  reason        TEXT,
  case_number   INTEGER,

  active        INTEGER NOT NULL DEFAULT 1,
  expires_at    INTEGER,                          -- NULL means never expires
  cleared_at    INTEGER,
  cleared_by    TEXT,

  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_warnings_user ON warnings (guild_id, user_id, active, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_warnings_expiry ON warnings (active, expires_at);

-- ----------------------------------------------------------------------------
-- Notes: private moderator notes about a user. Never shown to the user and
-- never DM'ed. Surfaced by the notes command and in whois for staff only.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id      TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  author_id     TEXT NOT NULL,
  content       TEXT NOT NULL,
  case_number   INTEGER,

  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_user ON notes (guild_id, user_id, active, created_at DESC);

-- ----------------------------------------------------------------------------
-- Punishments: current state of mutes, bans, and temporary roles.
-- Only one active row per (guild, user, type, role) so an unmute/expiry can
-- flip a single well-known row instead of scanning the case history.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS punishments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id      TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  type          TEXT NOT NULL,                    -- mute | ban | role
  role_id       TEXT,                             -- only for type = 'role'

  reason        TEXT,
  moderator_id  TEXT,
  case_number   INTEGER,

  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER,                          -- NULL means permanent
  cleared_at    INTEGER,
  cleared_by    TEXT,

  updated_at    INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_punishments_unique
  ON punishments (guild_id, user_id, type, IFNULL(role_id, ''));
CREATE INDEX IF NOT EXISTS idx_punishments_active ON punishments (guild_id, user_id, active);
CREATE INDEX IF NOT EXISTS idx_punishments_expiry ON punishments (active, expires_at);

-- ----------------------------------------------------------------------------
-- Automod strikes: escalating punishment input.
-- Weighted strike events with a rolling window; the Worker returns the active
-- total so the bot can pick the correct escalation step.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS automod_strikes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  rule        TEXT NOT NULL,                      -- invites | links | words | caps | mentions | emoji
  weight      INTEGER NOT NULL DEFAULT 1,
  reason      TEXT,
  channel_id  TEXT,
  message_id  TEXT,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_strikes_user ON automod_strikes (guild_id, user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_strikes_expiry ON automod_strikes (expires_at);

-- ----------------------------------------------------------------------------
-- Automod settings: one row per guild holding the full rule set, escalation
-- ladder, raid protection settings, and per-rule exemptions as JSON.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS automod_settings (
  guild_id     TEXT PRIMARY KEY,
  enabled      INTEGER NOT NULL DEFAULT 1,
  settings     TEXT NOT NULL DEFAULT '{}',        -- JSON: { rules, escalation, raid, exemptions }
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- ----------------------------------------------------------------------------
-- Logging settings: per-guild, per-event granularity and channel routing.
-- Kept separate from guilds so log routing can be updated independently and
-- queried without loading the whole configuration document.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logging_settings (
  guild_id         TEXT PRIMARY KEY,
  channels         TEXT NOT NULL DEFAULT '{}',    -- JSON: slot -> channel id
  events           TEXT NOT NULL DEFAULT '{}',    -- JSON: event key -> { enabled, channelId }
  ignore_channel_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array: channels never logged
  ignore_bot_messages INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- ----------------------------------------------------------------------------
-- Scheduled tasks: durable queue for tempmute, tempban, temprole, lockdown
-- expiry, and warning expiry. Survives bot restarts on Wispbyte.
-- Status lifecycle: pending -> running -> done | failed | cancelled.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT NOT NULL,
  type         TEXT NOT NULL,                     -- unmute | unban | unlock | remove_role | ...
  target_id    TEXT,                              -- user id or channel id depending on type
  payload      TEXT NOT NULL DEFAULT '{}',        -- JSON: { roleId, moderatorId, reason, caseNumber, ... }

  run_at       INTEGER NOT NULL,                  -- epoch ms when the task becomes due
  status       TEXT NOT NULL DEFAULT 'pending',
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  last_error   TEXT,
  case_number  INTEGER,

  claimed_at   INTEGER,
  completed_at INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_due ON scheduled_tasks (status, run_at);
CREATE INDEX IF NOT EXISTS idx_tasks_guild ON scheduled_tasks (guild_id, status, run_at);
CREATE INDEX IF NOT EXISTS idx_tasks_target ON scheduled_tasks (guild_id, target_id, status);

-- ----------------------------------------------------------------------------
-- Bot status: single-row heartbeat so uptime and version can be inspected
-- from D1 without scraping logs.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bot_status (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  version        TEXT,
  started_at     INTEGER,
  last_heartbeat INTEGER,
  guild_count    INTEGER,
  latency_ms     INTEGER,
  notes          TEXT
);

-- ----------------------------------------------------------------------------
-- Maintenance views: convenience projections used by the Worker.
-- ----------------------------------------------------------------------------

-- Active warnings per user, used by the warnings command and whois.
CREATE VIEW IF NOT EXISTS active_warnings AS
  SELECT guild_id, user_id, COUNT(*) AS warning_count
  FROM warnings
  WHERE active = 1 AND (expires_at IS NULL OR expires_at > (unixepoch('subsec') * 1000))
  GROUP BY guild_id, user_id;

-- Active temporary punishments due for expiry, used by monitoring queries.
CREATE VIEW IF NOT EXISTS pending_expiries AS
  SELECT guild_id, user_id, type, expires_at, case_number
  FROM punishments
  WHERE active = 1 AND expires_at IS NOT NULL
  ORDER BY expires_at ASC;
