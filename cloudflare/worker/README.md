# Moderation Gateway (Cloudflare Worker)

The only component that can reach Cloudflare D1. The Discord bot calls this API over
HTTPS and is authenticated with a shared bearer token stored as a Worker secret.

Full deployment instructions live in the repository root `README.md`
(section "Cloudflare setup"). This file documents the Worker's own contract.

## Endpoints

Every route except `/health` requires `Authorization: Bearer <WORKER_AUTH_TOKEN>`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Public liveness probe, no identifiers returned |
| GET | `/v1/health` | Readiness, confirms D1 reachability and KV state |
| POST | `/v1/bot/heartbeat` | Records version, uptime, guild count, latency |
| GET | `/v1/bot/status` | Reads the last heartbeat row |
| GET | `/v1/guilds/:guildId/config` | Full guild configuration document |
| PUT | `/v1/guilds/:guildId/config` | Merges `{ patch }` into the configuration |
| DELETE | `/v1/guilds/:guildId` | Deletes every row belonging to the guild |
| GET | `/v1/guilds/:guildId/stats` | Case, warning, note, and task counters |
| POST | `/v1/guilds/:guildId/cases` | Creates a case with optional warning, punishment, task |
| GET | `/v1/guilds/:guildId/cases` | Lists cases with filters and pagination |
| GET | `/v1/guilds/:guildId/cases/export` | Export rows for backup |
| GET | `/v1/guilds/:guildId/cases/:caseNumber` | Single case |
| PATCH | `/v1/guilds/:guildId/cases/:caseNumber` | Updates reason, status, metadata |
| GET | `/v1/guilds/:guildId/warnings` | Warnings for a user (`?userId=`) |
| GET | `/v1/guilds/:guildId/warnings/count` | Active and total counts |
| POST | `/v1/guilds/:guildId/warnings/clear` | Clears every active warning for a user |
| DELETE | `/v1/guilds/:guildId/warnings/:warningId` | Removes one warning |
| PATCH | `/v1/guilds/:guildId/warnings/:warningId` | Edits a warning |
| GET/POST | `/v1/guilds/:guildId/notes` | Private staff notes |
| DELETE | `/v1/guilds/:guildId/notes/:noteId` | Removes a note |
| GET/POST | `/v1/guilds/:guildId/punishments` | Current mute, ban, temporary role state |
| POST | `/v1/guilds/:guildId/punishments/clear` | Clears punishment state |
| GET/POST | `/v1/guilds/:guildId/strikes` | Automod strike total and recording |
| POST | `/v1/guilds/:guildId/strikes/reset` | Resets strikes for a user |
| GET/PUT | `/v1/guilds/:guildId/automod` | Automod configuration document |
| GET/PUT | `/v1/guilds/:guildId/logging` | Logging configuration document |
| POST | `/v1/tasks/claim` | Atomically claims due scheduled tasks |
| GET/POST | `/v1/guilds/:guildId/tasks` | List or create scheduled tasks |
| POST | `/v1/guilds/:guildId/tasks/cancel` | Cancels pending tasks |
| POST | `/v1/guilds/:guildId/tasks/:taskId/complete` | Marks a task finished or failed |

## Responses

Success:

```json
{ "ok": true, "config": { } }
```

Failure:

```json
{ "ok": false, "error": { "code": "INVALID_PAYLOAD", "message": "action must be one of: ..." } }
```

Codes in use: `UNAUTHORIZED`, `NOT_FOUND`, `METHOD_NOT_ALLOWED`, `BAD_REQUEST`,
`INVALID_PAYLOAD`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`, `INTERNAL_ERROR`.

Validation messages name the offending field only. They never include SQL, bindings,
identifiers, or stack traces.

## Security properties

- Token comparison is length independent and does not short-circuit.
- Identical `401` responses for missing, malformed, and incorrect tokens.
- A token shorter than 16 characters authorises nothing, so a misconfigured secret fails
  closed rather than open.
- JSON bodies are size limited and must declare `Content-Type: application/json`.
- Identifiers in paths must be snowflakes; internal table identifiers never come from a
  request.
- All statements use bound parameters.
- No CORS headers are emitted: the API is not intended for browsers.
- Optional KV rate limiting is keyed on a hash of the presented token, not on IP.
- Errors from D1 are converted to a generic `INTERNAL_ERROR`; details stay in
  `wrangler tail`.

## Local development

```bash
cp .dev.vars.example .dev.vars      # set WORKER_AUTH_TOKEN
npm run schema:local                # apply ../schema.sql to the local D1
npx wrangler dev                    # http://127.0.0.1:8787
```

Point the bot at the local gateway with `WORKER_BASE_URL=http://127.0.0.1:8787`.

## Operational notes

- `CONFIG_CACHE_SECONDS` sets the KV configuration cache lifetime, `0` disables it.
- `RATE_LIMIT_PER_MINUTE` sets the per-client request budget when KV is bound.
- `MAX_BODY_BYTES` bounds request bodies, default 256 KB.
- Workers Logs are enabled in `wrangler.toml` for dashboards and `wrangler tail`.
