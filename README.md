# Discord Moderation Bot

A production-ready Discord moderation bot built on discord.js v14 with Cloudflare D1
storage behind an authenticated Cloudflare Worker gateway.

- Slash commands are the default interface and work in every server. Prefix commands are an
  optional hybrid mode.
- Every reply, log entry, wizard screen, and error message is an embed built from one
  shared utility, with a consistent colour language and case numbering.
- All configuration and moderation data lives in Cloudflare D1, reached only through a
  Worker that holds the database binding. The bot never sees a database credential.
- No emoji appears anywhere: not in replies, embeds, comments, logs, or documentation.
  Plain text and standard symbols such as `->` are used instead.

---

## Table of contents

1. [Feature overview](#feature-overview)
2. [Architecture](#architecture)
3. [Project structure](#project-structure)
4. [Requirements](#requirements)
5. [Local development on macOS with VS Code](#local-development-on-macos-with-vs-code)
6. [Environment variables](#environment-variables)
7. [Cloudflare setup](#cloudflare-setup)
8. [Deploying the bot to Wispbyte](#deploying-the-bot-to-wispbyte)
9. [Running the setup wizard](#running-the-setup-wizard)
10. [Command reference](#command-reference)
11. [Design decisions](#design-decisions)
12. [Security model](#security-model)
13. [Verification and tests](#verification-and-tests)
14. [Troubleshooting](#troubleshooting)

---

## Feature overview

**Core moderation**

`kick`, `ban`, `tempban`, `softban`, `unban`, `mute` (native timeout), `tempmute`, `unmute`,
`warn`, `warnings`, `delwarn`, `clearwarnings`, `note`, `notes`, `delnote`, `purge`,
`slowmode`, `lockdown`, `unlock`, `forcenick`, `nicklock`, `addrole`, `removerole`,
`temprole`, `case`, `modlog`.

- Every action produces a case with a per-guild case number, stored in D1.
- Temporary actions write a durable task row, so a tempmute or tempban still expires after
  a bot restart.
- Role hierarchy is enforced everywhere: nobody can act on someone at or above them, the
  server owner is protected, and the bot refuses actions above its own highest role.
- Optional reason requirement, optional evidence URL, optional direct message notification.

**Tickets**

- `ticketpanel` posts a message with an Open Ticket button. Each press creates a private channel
  that only the member, the support role, and the bot can see.
- `ticketsetup #category @support #log-channel` sets the category, support role, and transcript log.
- Closing a ticket (button or `ticketclose`) saves a plain-text transcript to the log channel,
  then deletes the channel. One open ticket per member.

**Automod**

- Invite filter with an allow list of invite codes
- Link filter with domain allow list and block list
- Custom banned word list with whole-word matching and an allow list
- Excessive caps detection
- Mass mention detection
- Emoji spam detection
- Raid protection: mass-join window with alert or automatic lockdown and optional auto unlock
- Escalating punishment ladder driven by weighted strikes in a rolling window
- Per-rule toggle, per-rule punishment, per-rule strike weight

There is deliberately **no flood or rate-based spam detection**. Content filtering plus the
escalation ladder is the intended enforcement path, and a separate flood detector would
double-punish the same behaviour.

**Logging**

Every loggable event has its own toggle and its own channel override:

| Category | Events |
| --- | --- |
| Moderation | `mod_action`, `case_update`, `automod_trigger`, `punishment_expired` |
| Messages | `message_delete`, `message_edit`, `message_bulk_delete` |
| Members | `member_join`, `member_leave`, `member_ban`, `member_unban`, `member_nickname_update`, `member_roles_update` |
| Voice | `voice_join`, `voice_leave`, `voice_move` |
| Server | `channel_create`, `channel_delete`, `channel_update`, `role_create`, `role_delete`, `role_update`, `guild_update`, `invite_create`, `invite_delete` |

Message deletions are cross-referenced against the audit log to identify who removed a
message, and the log states plainly when Discord kept no trace.

**Setup wizard**

An interactive wizard configures the prefix, staff roles, mute role, log channels
(created automatically or selected), enabled log event types, automod preset, lockdown
defaults, and the reason and direct message policies. Nothing is saved until the final
summary is confirmed.

**Operations**

- Health endpoint (`/health`, `/healthz`) for uptime monitoring, no identifiers exposed
- Heartbeat rows written to D1 so version, uptime, and latency are inspectable
- Graceful shutdown on `SIGINT` and `SIGTERM`, with in-flight log embeds flushed
- Automatic gateway reconnection handled by discord.js, with state mirrored to the health endpoint
- Admin-only JSON export of the moderation log

---

## Architecture

```
  Discord
     |
     v
  +--------------------------+        HTTPS + bearer token        +---------------------------+
  |  Node process (Wispbyte) |  ------------------------------>   |  Cloudflare Worker        |
  |  discord.js v14          |                                    |  moderation-gateway       |
  |  commands, events,       |  <------------------------------   |  validation, routing      |
  |  automod, scheduler      |        JSON responses              |  parameterised SQL        |
  +--------------------------+                                    +-------------+-------------+
                                                                                |
                                                       D1 binding (no public endpoint)
                                                                                |
                                                                +---------------v--------------+
                                                                |  Cloudflare D1 (SQLite)      |
                                                                |  configs, cases, warnings,   |
                                                                |  notes, punishments,         |
                                                                |  strikes, scheduled tasks    |
                                                                +------------------------------+
                                                                                |
                                                                +---------------v--------------+
                                                                |  Cloudflare KV (optional)    |
                                                                |  config cache, rate limits   |
                                                                +------------------------------+
```

Why a Worker in the middle: D1 has no public network endpoint and is only reachable from a
Worker binding. The Worker is therefore the security boundary. It validates every field
again, uses bound parameters for every statement, and returns generic errors.

---

## Project structure

```
moderation-bot/
├── .env.example                 Environment template (placeholders only)
├── .gitignore                   Excludes .env, node_modules, logs, local databases
├── .editorconfig
├── ecosystem.config.js          Optional PM2 process definition for Wispbyte
├── package.json
├── README.md
├── cloudflare/
│   ├── schema.sql               D1 schema for every table and view
│   └── worker/
│       ├── package.json
│       ├── wrangler.toml        Bindings and non-secret variables
│       ├── .dev.vars.example    Local secret template for wrangler dev
│       └── src/
│           ├── index.js         Route table, auth, rate limit, error mapping
│           ├── core/            http.js, validate.js, db.js
│           ├── data/            guilds, cases, moderation, settings, tasks
│           └── routes/          bot, guilds, cases, moderation, settings, tasks
├── scripts/
│   ├── syntax-check.js          Parses every file (npm run check)
│   ├── self-test.js             Offline unit and routing checks (npm run selftest)
│   └── integration-test.js      Full pipeline test with fakes (npm run test:integration)
└── src/
    ├── index.js                 Startup, shutdown, heartbeat
    ├── automod/
    │   ├── rules.js             Pure rule evaluation
    │   ├── automodService.js    Enforcement, strikes, escalation
    │   └── raidService.js       Mass-join detection and lockdown
    ├── commands/
    │   ├── moderation/          kick, ban, mute, warn, purge, case, modlog, ...
    │   ├── channels/            purge, slowmode, lockdown, unlock
    │   ├── roles/               addrole, removerole, temprole, forcenick, nicklock
    │   ├── configuration/       setup, config, prefix, export, syncslash
    │   ├── automod/             automod configuration
    │   ├── logging/             logconfig
    │   └── utility/             help, ping, whois, serverinfo, stats
    ├── config/
    │   ├── constants.js         Colours, actions, log event registry, messages
    │   ├── defaults.js          Default guild, automod, and logging documents
    │   └── env.js               Environment loading and validation
    ├── core/
    │   ├── client.js            discord.js client construction
    │   ├── context.js           Command context and reply helpers
    │   ├── dispatcher.js        Prefix and slash dispatch, rate limits, permissions
    │   ├── registry.js          Command loading and permission-aware listing
    │   └── setupWizard.js       Interactive wizard state machine
    ├── db/
    │   ├── index.js             Gateway initialisation
    │   ├── gateway.js           Every endpoint the bot may call
    │   ├── httpClient.js        Timeouts, retries, error normalisation
    │   └── repositories/        guilds, cases, warnings, notes, punishments, tasks
    ├── events/                  message, member, voice, server, guild, error handlers
    ├── services/
    │   ├── moderationService.js The pipeline every action flows through
    │   ├── punishmentService.js kick, ban, mute, warn, roles
    │   ├── channelService.js    purge, slowmode, lockdown, nicknames
    │   ├── loggingService.js    Per-event routing and audit attribution
    │   ├── taskService.js       Durable scheduled action worker
    │   ├── permissionService.js Levels and command gating
    │   ├── hierarchyService.js  Role hierarchy guards
    │   ├── rateLimitService.js  Command and action buckets
    │   ├── dmService.js         Punishment notifications
    │   └── healthService.js     Uptime endpoint
    └── utils/
        ├── embeds.js            The shared embed builder (all styling lives here)
        ├── errors.js            User-safe and internal error classes
        ├── logger.js            Redacting structured logger
        ├── sanitize.js          Input validation and escaping
        ├── duration.js          Duration parsing and formatting
        ├── parser.js            Entity resolution and tokenizing
        ├── objects.js           Deep merge and diff helpers
        └── args.js              Command argument helpers
```

---

## Requirements

- Node.js 20.18 or newer (Node 22 LTS recommended)
- A Discord application and bot token
- A Cloudflare account with Workers and D1 enabled
- The `wrangler` CLI for schema and Worker deployment (`npx wrangler`)

**Discord bot setup**

1. Create an application at the Discord Developer Portal and add a bot.
2. Under **Bot -> Privileged Gateway Intents**, enable **Server Members Intent** and
   **Message Content Intent**. The bot will not function without them.
3. Invite the bot with the `bot` and `applications.commands` scopes and grant:
   Manage Roles, Manage Channels, Kick Members, Ban Members, Timeout Members,
   Manage Messages, Manage Nicknames, View Audit Log, Read Message History, Send Messages,
   Embed Links, Attach Files, and Use External Emojis (for rendering existing emoji only).
4. Place the bot role above every role it must moderate.

---

## Local development on macOS with VS Code

```bash
# 1. Clone and enter the project
git clone <repository-url> moderation-bot
cd moderation-bot

# 2. Install dependencies
npm install

# 3. Create your environment file and fill it in
cp .env.example .env
$EDITOR .env

# 4. Validate everything parses and the offline tests pass
npm run verify

# 5. Run the bot with automatic restart on file changes
npm run dev
```

VS Code specifics:

- Copy `.vscode/launch.json.example` to `.vscode/launch.json` for a debug configuration
  that loads `.env` through the application itself (no secrets in the launch file).
- Copy `.vscode/settings.json.example` to `.vscode/settings.json` for consistent
  formatting and to keep generated folders out of search.
- Recommended extensions: ESLint (optional), EditorConfig for VS Code, and the
  Cloudflare Workers extension if you intend to edit the Worker locally.

Local Worker development alongside the bot:

```bash
# Terminal 1: run the gateway against local D1
cd cloudflare/worker
cp .dev.vars.example .dev.vars      # then set WORKER_AUTH_TOKEN
npm run schema:local                # apply cloudflare/schema.sql to the local database
npx wrangler dev                    # serves on http://127.0.0.1:8787

# Terminal 2: point the bot at the local gateway
#   WORKER_BASE_URL=http://127.0.0.1:8787
#   WORKER_AUTH_TOKEN=<same value as .dev.vars>
npm run dev
```

---

## Environment variables

Copy `.env.example` to `.env`. Never commit `.env`; it is already gitignored.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | yes | - | Bot token from the Developer Portal |
| `DEFAULT_PREFIX` | no | `!` | Prefix for guilds that have not chosen one |
| `ENABLE_SLASH_COMMANDS` | no | `true` | Registers slash commands globally at startup (up to an hour to appear the first time) |
| `SLASH_DEV_GUILD_ID` | no | - | Also register slash commands to this guild, where they appear instantly |
| `BOT_OWNER_IDS` | no | - | Comma-separated user ids that bypass permission checks |
| `BOT_ACTIVITY` / `BOT_ACTIVITY_TYPE` | no | `Server moderation` / `WATCHING` | Presence |
| `WORKER_BASE_URL` | yes | - | Gateway base URL, for example `https://moderation-gateway.<subdomain>.workers.dev` |
| `WORKER_AUTH_TOKEN` | yes | - | Shared secret; must match the Worker secret |
| `WORKER_TIMEOUT_MS` | no | `10000` | Per-request timeout |
| `WORKER_MAX_RETRIES` | no | `3` | Retries for safe requests |
| `LOG_LEVEL` | no | `info` | `error`, `warn`, `info`, `debug` |
| `LOG_INTERNAL_CHANNEL_ID` | no | - | Private channel for internal error mirrors |
| `LOG_TO_FILE` / `LOG_DIR` | no | `true` / `logs` | Written stack traces for maintainers |
| `HEALTH_ENABLED` / `HEALTH_HOST` / `PORT` | no | `true` / `0.0.0.0` / `3000` | Health endpoint |
| `RATE_LIMIT_ENABLED` | no | `true` | Command rate limiting |
| `RATE_LIMIT_WINDOW_MS` | no | `10000` | Rate limit window |
| `RATE_LIMIT_MAX_COMMANDS` | no | `6` | Commands per user per window |
| `RATE_LIMIT_MAX_MOD_ACTIONS` | no | `3` | State-changing actions per user per window |
| `SCHEDULER_ENABLED` | no | `true` | Durable task polling |
| `SCHEDULER_INTERVAL_MS` | no | `30000` | Poll interval |
| `SCHEDULER_BATCH_SIZE` | no | `25` | Tasks claimed per poll |
| `SCHEDULER_STARTUP_GRACE_MS` | no | `5000` | Delay before the first poll |
| `MAX_PURGE_COUNT` | no | `1000` | Hard cap on a single purge |
| `MAX_TIMEOUT_DURATION` | no | `28d` | Hard cap on mute length |
| `MAX_TEMPBAN_DURATION` | no | `365d` | Hard cap on temporary ban length |
| `NODE_ENV` / `TZ` | no | `production` / `UTC` | Runtime |

`WORKER_AUTH_TOKEN` is a secret. Generate one with `openssl rand -hex 32` and use the
same value for the bot and the Worker. The bot registers both secrets with the logger at
startup, so they are redacted even if a stack trace or error message contains them.

---

## Cloudflare setup

### 1. Create the D1 database

```bash
cd cloudflare/worker
npx wrangler login
npx wrangler d1 create moderation-bot
```

Copy the printed `database_id` into `cloudflare/worker/wrangler.toml`, replacing
`REPLACE_ME_WITH_D1_DATABASE_ID`.

### 2. Apply the schema

```bash
cd cloudflare/worker

# Remote (production)
npx wrangler d1 execute moderation-bot --remote --file=../schema.sql

# Or from the repository root
npm run db:schema:remote
```

The schema is idempotent, so re-running it is safe. It creates `guilds`,
`guild_counters`, `cases`, `warnings`, `notes`, `punishments`, `automod_strikes`,
`automod_settings`, `logging_settings`, `scheduled_tasks`, `bot_status`, and two
convenience views.

### 3. Set the shared secret

```bash
cd cloudflare/worker
npx wrangler secret put WORKER_AUTH_TOKEN
# paste the same value you put in the bot's .env
```

Secrets are stored encrypted on Cloudflare. Never place them in `wrangler.toml`.

### 4. Optional KV namespace

KV backs two optional features: a short-lived guild configuration cache and the gateway
rate limiter. The Worker runs correctly without it.

```bash
npx wrangler kv namespace create MODERATION_KV
# uncomment the [[kv_namespaces]] block in wrangler.toml and paste the id
```

### 5. Deploy the Worker

```bash
cd cloudflare/worker
npx wrangler deploy
```

The deploy output prints the Worker URL. Set it in the bot's `.env` as
`WORKER_BASE_URL`. Verify it:

```bash
curl https://<your-worker-url>/health
# {"ok":true,"service":"moderation-gateway","version":"1.0.0","time":"..."}

curl -H "Authorization: Bearer <token>" https://<your-worker-url>/v1/health
# confirms D1 reachability and KV state
```

`/health` is intentionally public and returns liveness only. Every other route requires
the bearer token and answers with an identical `401` for a missing, malformed, or wrong
token. There are no CORS headers, because the API is not meant for browsers.

### 6. Applying schema changes later

```bash
npx wrangler d1 execute moderation-bot --remote --command "ALTER TABLE guilds ADD COLUMN example TEXT"
```

---

## Deploying the bot to Wispbyte

Wispbyte runs a standard Node process. Both of these approaches work; pick one.

**Option A: npm start (panel-managed process)**

1. Upload the project (or connect the Git repository).
2. Run the install step: `npm install --omit=dev`.
3. Set the start command to `npm start` (which runs `node src/index.js`).
4. Add every variable from `.env.example` in the panel's environment section. Do not
   upload a `.env` file unless the panel stores it privately.
5. Start the process and check the logs for `Bot ready`.

**Option B: PM2 with the included ecosystem file**

```bash
pm2 start ecosystem.config.js
pm2 save
```

The ecosystem file deliberately contains no secrets: environment values come from the
panel or a private `.env`. It configures a single fork instance, automatic restart, a
512 MB memory ceiling, a 10 second kill timeout for graceful shutdown, and log files
under `logs/`.

**Single instance rule:** run exactly one bot process per token per database. Case
numbers, scheduled task claiming, and rate limits assume a single instance. The Worker's
task claim is atomic, so a brief overlap during a deploy is safe, but steady-state
duplication is not supported.

**Uptime monitoring:** point the monitor at the health endpoint on the port you set with
`PORT` (default 3000). It returns `200` with a small JSON body:

```json
{"status":"ok","uptimeSeconds":3600,"ready":true,"guilds":12,"latencyMs":48,"degraded":false,"timestamp":"2026-01-01T00:00:00.000Z"}
```

Port `0` disables the listener. Set `HEALTH_ENABLED=false` if the panel does not allow
inbound ports.

**Discord intents note:** Wispbyte must be able to reach `discord.com` and your Worker
URL over HTTPS. If outbound traffic is restricted, the bot will log a gateway error on
startup and the health endpoint will report `degraded`.

---

## Running the setup wizard

```
/setup
```

Only server administrators (Discord's Administrator permission), the server owner, or bot owners
can run setup. Until setup is finished, every other command replies that the server has not been
set up yet. The bot's welcome message explains this when it joins.

The wizard is re-runnable and non-destructive: it starts from the current configuration
and only writes at the end.

1. **Welcome** - explains the steps. Nothing is saved until the final screen.
2. **Command prefix** - keep the current prefix or type a new one (up to 5 characters).
3. **Prefix commands** - enable or disable prefix command handling for the server.
4. **Administrator roles** - configuration access, log export, automod configuration.
5. **Moderator roles** - kick, ban, mute, warn, purge, lockdown, and the rest.
6. **Trusted roles** - read-only staff commands.
7. **Mute role** - create one (the bot adds deny overwrites for Send Messages, Add
   Reactions, and Speak in every text channel) or leave the server on native timeouts.
8. **Log channels** - create a private `Moderation` category with one channel per log
   type, or select existing channels slot by slot.
9. **Log event types** - choose which events are logged. Fine-tune individual events and
   destinations later with `logconfig`.
10. **Automod preset** - Recommended, Strict, Minimal, or configure later.
11. **Lockdown defaults** - which roles are denied Send Messages, and the automatic
    unlock delay.
12. **Behaviour** - whether a reason is required, and whether punished members receive a
    direct message.
13. **Summary** - the full configuration as an embed. Press Save, Back, or Cancel.

After saving, the completion embed lists the next steps. Review everything at any time
with `!config`, and change log routing with `!logconfig` or automod with `!automod`.

Only the member who started the wizard can drive it, and any other administrator
attempting to use the buttons is told that a setup is already running. Sessions expire
after 15 minutes of inactivity.

---

## Command reference

Prefix is shown as `!`; it is per-guild. Every command also accepts a mention of the bot
in place of the prefix, so `@Bot help` always works, even when prefix commands are
disabled. Run `!help` to see only the commands your roles allow.

### Moderation

| Command | Usage | Permission |
| --- | --- | --- |
| `kick` | `kick <member> <reason>` | Moderator |
| `ban` | `ban <member> [duration] <reason>` (`--purge=<days>`) | Moderator |
| `tempban` | `tempban <member> <duration> <reason>` | Moderator |
| `softban` | `softban <member> <reason>` | Moderator |
| `unban` | `unban <user id> <reason>` | Moderator |
| `mute` | `mute <member> [duration] <reason>` | Moderator |
| `tempmute` | `tempmute <member> <duration> <reason>` | Moderator |
| `unmute` | `unmute <member> [reason]` | Moderator |
| `warn` | `warn <member> <reason>` (`--expires=<days>`) | Moderator |
| `warnings` | `warnings <member> [--all] [--page=2]` | Moderator |
| `delwarn` | `delwarn <warning id> <reason>` | Moderator |
| `clearwarnings` | `clearwarnings <member> [reason]` | Moderator |
| `note` / `notes` / `delnote` | private staff notes | Moderator |
| `case` | `case <number>` | Moderator |
| `modlog` | `modlog <member or case number> [--page=2] [--action=ban]` | Moderator |

### Channels and roles

| Command | Usage | Permission |
| --- | --- | --- |
| `purge` | `purge <amount> [--user=@User] [--match=text] [--bots] [--humans] [reason]` | Moderator |
| `slowmode` | `slowmode [channel] <seconds> [reason]` | Moderator |
| `lockdown` | `lockdown [channel] <reason>` | Moderator |
| `unlock` | `unlock [channel] [reason]` | Moderator |
| `forcenick` | `forcenick <member> <nickname or reset> [reason]` | Moderator |
| `nicklock` | `nicklock <member> [nickname] [reason]` | Moderator |
| `addrole` / `removerole` | `<member> <role> [reason]` | Moderator |
| `temprole` | `temprole <member> <role> <duration> [reason]` | Moderator |

### Configuration

| Command | Usage | Permission |
| --- | --- | --- |
| `setup` | interactive wizard | Administrator |
| `config` | show the current configuration | Administrator |
| `prefix` | `prefix [new prefix or enable/disable]` | Administrator |
| `logconfig` | `logconfig [list/enable/disable/channel/slot/ignore/unignore] ...` | Administrator |
| `automod` | `automod [show/enable/disable/rule/set/words/links/invites/escalation/raid/exemption/strikes] ...` | Administrator |
| `export` | `export [amount]` - JSON backup of cases | Administrator |
| `syncslash` | `syncslash [clear]` - register slash commands | Administrator |

### Tickets

- `ticketpanel [channel]` (Administrator): post the Open Ticket button.
- `ticketsetup [category] [support role] [log channel]` (Administrator): configure tickets. Run with no arguments to see the current settings.
- `ticketclose` (anyone in a ticket, if they are the opener or staff): close the ticket and save a transcript.

Ticket actions for one server run one at a time, so simultaneous presses get separate numbers.

### Utility

`help [command]`, `ping`, `whois [member]`, `serverinfo`, `stats`, `doctor` (Administrator).
`doctor` is read-only: it reports the bot's connection, its permissions, and which command groups are ready.

Durations accept `30s`, `10m`, `2h`, `3d`, `1w`, and combinations such as `1d 2h`.

---

## Design decisions

**Slash first, prefix optional.** Slash commands are published globally at startup, so every
server the bot joins gets them. Global registration can take up to an hour to appear the first
time. Prefix commands are off by default; a server can turn them on in the setup wizard or
with `prefix`. Prefix commands keep working standalone with no registration step. Slash support maps options onto
the same positional arguments the prefix form uses, so behaviour is identical and there is
no second code path. The trade-offs are real: slash commands give native autocomplete and
option validation, while prefix commands support quoting, flexible ordering, and arguments
that a fixed option list cannot express (such as combining several purge filters).

**Native timeouts instead of a mute role.** Discord's timeout is permission-proof, audited,
and self-expiring, so it is the default. A mute role is still supported for servers that
want one, and the wizard configures its channel overwrites automatically.

**Storage in D1 behind a Worker.** D1 is not reachable from an external process, so the
Worker is mandatory rather than optional. It also gives one place to enforce validation,
rate limits, and statement parameterisation.

**Case numbering in the database.** Case numbers come from an atomic upsert with
`RETURNING`, so two simultaneous actions can never share a number, even though the bot
itself is single-instance.

**Durable scheduled tasks.** Timed actions are rows, not timers. A restart on Wispbyte
cannot lose a pending unmute, unban, role removal, or lockdown expiry. Claiming is a
single `UPDATE ... RETURNING`, so a task is never executed twice, and tasks stuck in
`running` after a crash are reclaimed after a stale timeout.

**Strikes instead of flood detection.** Automod records weighted strikes in a rolling
window. When the total lands exactly on a configured step, that step's punishment is
applied. This makes escalation deterministic and avoids punishing the same burst twice.

**Configuration reads are cached, writes invalidate.** Configuration, automod, and logging
documents are cached in memory for 60 seconds and invalidated on write, so the hot path
(message handling) rarely touches the network.

---

## Security model

- No secret, token, database id, or Worker URL is ever printed to the console, written to
  an embed, or shown in an error reply. The logger redacts registered secrets, values
  under sensitive keys, token-shaped strings, and `*.workers.dev` hosts.
- All configuration comes from environment variables. No token, guild id, or channel id is
  hardcoded anywhere in the source.
- Users see generic failure messages. Full stack traces go to `logs/internal.log` and,
  optionally, a private internal channel configured with `LOG_INTERNAL_CHANNEL_ID`.
- Every SQL statement in the Worker uses bound parameters. Identifiers never come from a
  request: they are chosen from allow lists in code.
- The Worker validates every field independently of the bot, so a hand-crafted request is
  rejected as firmly as a bot bug would be.
- Authorization is role-based with four levels plus explicit guild owner and bot owner
  bypass. Commands declare their level, the dispatcher enforces it, and the help command
  only lists what the caller may use.
- Rate limiting protects the bot and the gateway from command abuse, separately from
  automod, which inspects message content only.
- Command and message input is sanitized: control characters removed, mentions neutralised,
  lengths capped, and URLs restricted to http(s).

---

## Verification and tests

```bash
npm run check              # parse every file with node --check
npm run selftest           # 431 offline checks: registry, config, utils, rules, Worker routing
npm run test:integration    # end-to-end pipeline test with fake Discord objects and a fake transport
npm run verify             # all three, in order
```

The self test loads every source module, validates every command definition and slash
option, checks that each log event maps to a real channel slot, and drives the Worker's
route table with a stubbed database to confirm authentication, routing, validation, and
error mapping. The integration test executes real commands against fakes and asserts the
resulting embeds, case payloads, punishment rows, and error classification.

No test touches the network or requires a real token.

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Missing required environment variable` at startup | `.env` is incomplete, or the panel variables were not saved |
| Bot connects but ignores commands | Message Content Intent is off in the Developer Portal |
| Members are not resolved by name | Server Members Intent is off |
| `The bot is missing required permissions` | The bot role lacks the permission, or sits below the target role |
| `Storage gateway is not reachable at startup` | Wrong `WORKER_BASE_URL`, Worker not deployed, or outbound HTTPS blocked |
| `401` from the gateway | `WORKER_AUTH_TOKEN` differs between the bot and the Worker secret |
| Logs never appear | Run `logconfig` and confirm the event is enabled and a channel is assigned |
| Purge removes fewer messages than requested | Discord cannot bulk delete messages older than 14 days; those are removed individually, 50 per run |
| Temporary actions do not expire | `SCHEDULER_ENABLED` is false, or the panel blocked outbound requests |
| Mute fails with a permission error | The bot needs Timeout Members, and its role must be above the target |

Logs to check, in order: the console for `[startup]` and `[scheduler]` lines, then
`logs/internal.log` for full traces, then `npx wrangler tail` in `cloudflare/worker` for
gateway-side errors.

---

## License

MIT. See `LICENSE`.
