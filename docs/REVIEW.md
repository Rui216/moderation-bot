# Bot review and reliability update

## What this repository contains

This is a Node.js / discord.js v14 bot, not a single bot file. The entry point is
`src/index.js`. It has 42 commands in eight categories:

| System | Existing capabilities |
| --- | --- |
| Moderation | Warnings, bans, temporary bans, softbans, kicks, native timeouts, temporary mutes, reversals, case history, private staff notes |
| Channel and role tools | Purge filters, slowmode, lockdown/unlock, forced/locked nicknames, role assignment/removal, temporary roles |
| Automod | Invite, link, banned-word, caps, mention, and emoji rules; exemptions; weighted strikes; escalation |
| Raid protection | Join-rate detection, alerts, optional lockdown and scheduled unlock |
| Logging | Configurable routes/toggles for moderation, message, member, voice, and server events |
| Tickets | Private support channels, persistent open-ticket tracking, staff access, transcript export |
| Configuration and utility | Moderation setup wizard, prefix/slash settings, help, diagnostics, stats, user/server information, case export |
| Persistence and operations | Authenticated Cloudflare Worker API, D1 schema/repositories, durable expiry tasks, rate limiting, health endpoint, PM2 configuration |

There is no web dashboard. The interactive interfaces are native Discord messages,
buttons, select menus, and forms. Persistent data is held in D1, not on the bot's disk.

## Using the ticket system

1. Create a ticket category, a support staff role, a **private staff transcript channel**,
   and a channel where members will find the public panel.
2. Give the bot View Channel, Manage Channels, and Manage Roles in the category. In the
   transcript channel it needs View Channel, Send Messages, Embed Links, and Attach Files.
   It needs View Channel, Send Messages, and Embed Links in the panel channel. Ticket
   channels explicitly allow the bot to read history and send files/messages.
3. Run `/ticketsetup` without options. The prefix equivalent also works if prefix commands
   are enabled. This opens four native pickers, not a list limited to the first 25 channels.
4. Choose the category, support role, transcript channel, and panel channel. `@everyone`
   and managed integration/bot roles are not valid support roles.
5. Use **Edit panel text** to customize the title and description, then **Preview**.
6. Choose **Save only** or **Save & publish**. Cancel abandons the draft. Nothing is saved
   merely by selecting options. Permission checks run again before saving.
7. Members press **Open Ticket**, enter a subject and description, and receive a private
   channel link. Repeat submissions return the existing ticket instead of creating another.
8. The opener, a support-role member, or a member with Manage Channels may request closure.
   **Save transcript & close** confirms deletion; **Keep open** cancels. `ticketclose`
   follows the same confirmation flow.

Direct setup remains available:

```text
ticketsetup CATEGORY_ID @Support #ticket-transcripts
/ticketsetup log_channel:#new-transcripts
```

Optional slash arguments retain their positions: changing only `log_channel` no longer
mistakes it for the category. Direct setup validates the combined saved/new configuration.
Use `ticketpanel #help` to publish another copy of the saved panel. Previously posted panels
are not edited automatically, and publishing intentionally creates a new message. Changes
to the category/support role apply to newly created channels; review existing channel
permission overwrites manually when changing your support team.

### Transcript behavior

- History is fetched in pages of 100 messages, ordered oldest-first in the output.
- Text, author IDs, timestamps, embed data, and attachment URLs are included.
- Safety bounds: 10,000 messages and approximately 7 MiB of transcript text. If exceeded,
  the bot refuses deletion; staff must archive the channel manually.
- A missing log destination, fetch failure, upload failure, or Discord deletion failure
  does not deliberately discard the ticket. A failed delete leaves the record intact.
- Attachment **URLs** are recorded, not the attachment files themselves. URLs may expire.
- This is an export snapshot, not an immutable archive. Deleted messages cannot be recovered;
  messages arriving during export may not be included. Administrators can always access
  private channels. Put the transcript log somewhere appropriate for sensitive support data.
- If deletion succeeds but storage cleanup fails, a stale record can remain. A subsequent
  ticket opening reconciles records whose channels were definitely deleted. Transient
  Discord errors are not treated as proof of deletion.

## Bugs addressed

### Tickets and interactions

- Serialized ticket creation, closure, and setup writes per guild within the supported
  single bot process; serialized shared `misc` edits across tickets, channel locks, and
  nickname locks.
- Protected against duplicate tickets/counters on simultaneous submissions, unsafe support
  roles, stale channel references, storage failures after channel creation, and swallowed
  transcript errors.
- Added confirmation/cancel to both ticket-close interfaces, early interaction acknowledgements,
  ownership/expiry checks on wizard controls, and permission/destination validation.
- Added forms for support requests, configurable panel content, preview, and explicit publishing.
- Deferred slash commands before storage I/O; initial results edit the deferred response instead
  of leaving a loading message and sending an unrelated follow-up.
- Enforced the total embed text budget and split multi-embed replies across messages when needed.

### Moderation, automod, and scheduled actions

- Fixed slowmode slash commands ignoring their channel option; preserved numeric text in reasons.
- Invalid explicit channel IDs no longer fall back to a server-wide lock/unlock.
- Accepted compound duration arguments such as `1d2h`.
- Fixed server unlock with a supplied channel list dereferencing a null channel.
- Saved original Send Messages overrides before lockdown; restored explicit allows rather than
  blindly replacing every deny with inheritance. Bulk/system unlocks only restore tracked locks,
  preserving unrelated pre-existing restrictions. Failed overwrite edits are no longer counted
  as successes. Scheduled unlocks carry the roles actually locked.
- Fixed temporary-role removal clearing/cancelling *all* of a member's temporary roles instead
  of the selected role.
- Scheduled all native-mute expiries, including default-duration mutes. Removed optional mute
  roles even after Discord's timeout expired, and retained their role ID in new task payloads.
- Stopped treating arbitrary Discord/network errors as missing members, bans, roles, or channels.
- Retried task failures with a delay and attempt cap; prevented old case-linked expiry tasks
  from undoing newer stored punishments; cleaned up scheduler timers on restart/stop.
- Re-evaluated edited message content and selected the highest newly crossed weighted-strike
  threshold. Corrected active strike queries counting already-expired strikes.
- Reported partial success explicitly if Discord applied a moderation action but case/expiry
  persistence subsequently failed. Staff are warned not to blindly repeat it.

### Storage and setup safety

- Accepted `system` as the case actor, fixing rejection of automod/scheduler/raid case writes.
- Moved warning insertion into the same transactional D1 batch as its case and side effects,
  preventing orphan warnings after a failed batch.
- Rejected oversized `misc` updates instead of silently replacing all state with `{}`.
- Read mutable guild state directly from D1 instead of eventually consistent KV. The bot still
  caches normal configuration reads in memory; state mutations force a fresh read.
- Protected completed/cancelled tasks from being overwritten by a late completion call.
- Rejected malformed successful gateway responses instead of treating them as empty configuration.
- Hardened recursive configuration merging against prototype keys.
- Improved the main moderation wizard: native role pickers, paginated log-event selection,
  preserved existing log destinations and per-event routing, bound controls to their message,
  scoped typed input to its channel, rechecked admin permissions, and fixed expiry rendering.
- Kept the bot explicitly able to see auto-created private log channels and excluded threads
  from mute-role channel overwrite operations.

## Deploying this update

1. Back up your D1 data before upgrading production.
2. Deploy the updated **Cloudflare Worker as well as the bot**. The Worker changes are essential
   for safe size validation, role-scoped cleanup, system cases, and task retry behavior.
   Use the existing deployment instructions in the root/Worker READMEs.
3. No schema migration is required for these changes; the existing schema is reused.
4. Run `npm ci` and `npm run verify` in a development/CI checkout. Production may use
   `npm ci --omit=dev` because `sql.js` is only used by tests.
5. Restart the bot. Run **one bot process per token/database**, as configured in the PM2 file.
6. Existing ticket IDs/counters are preserved. If your old setup had no transcript log,
   configure one before opening or closing tickets. New panels are not required to make old
   `ticket:open` buttons work; those buttons now show the intake form.
7. No slash command names/options were added, so resync is not needed just for the new controls.
8. Lockdowns created before this version have no permission snapshots. Use an explicit
   `unlock #channel reason` for a legacy lock and review its permissions. Such an explicit
   legacy unlock restores inheritance because the original setting is unknowable. Automatic
   and bulk unlocks do not guess at untracked restrictions.
9. Review already-failed scheduled tasks manually. This update does not requeue historical
   failures or reconstruct missing expiry tasks from an earlier storage outage.

## Verification and limits

`npm run verify` includes module/registry checks, command integration tests, ticket failure
and concurrency tests, service regressions, and Worker data tests against real SQLite via
`sql.js`. CI is configured for Node 20 and 22. No secrets or network connection are needed
for the tests after dependencies are installed.

**Local verification:** Node 22.22.3; 117 JavaScript files parsed, 462 self-checks,
81 command integration checks, and 38 ticket/service/SQLite regression scenarios passed.
The production dependency audit reported no known vulnerabilities. The newly added CI
workflow has not been run on GitHub as part of this session.

**Still requires live validation:** Discord API permission behavior, modal submission from
real clients, category capacity, actual file upload limits, and your deployed D1/Worker bindings.
The offline SQLite adapter tests SQL/transaction behavior but is not the Cloudflare runtime.
No production deployment, moderation actions, or live database modifications were performed
as part of this review.

Suggested disposable-server smoke test:

- Complete both setup wizards; cancel and expire a draft; attempt another user's controls.
- Publish a panel, submit twice rapidly, verify private access with an ordinary second member.
- Create more than 100 ticket messages, close, and verify the transcript's first and last messages.
- Remove Attach Files from the transcript destination and confirm closure fails without deletion.
- Apply a short mute with the optional role, then verify both timeout and role expiry.
- Give one member two temporary roles; remove one and check the other's expiry still runs.
- Lock a channel with an existing explicit allow and verify it is restored on unlock.
- Edit a clean message into a rule violation; test a weighted jump over an escalation step.

Known architectural boundaries:

- In-process queues are **not distributed locks**. Running duplicate bot instances or external
  writers concurrently against `misc` can still lose updates. Move tickets/locks to dedicated
  transactional tables before attempting multi-process operation.
- `misc` remains bounded at 16 KiB. Ticket, nickname-lock, and lockdown state share that budget;
  writes fail safely when full. The 100-ticket cap is not a guarantee that every configuration
  can fit 100 records alongside other state.
- Discord actions and D1 writes cannot form a single transaction. Crashes in between can
  require staff reconciliation. Transcript delivery may repeat if upload succeeded but deletion
  failed and closure is retried. Scheduled actions are at-least-once, not exactly-once.
- Automod is a configurable content filter, not a comprehensive anti-abuse system. It does not
  include a general message-flood detector; it retains the existing weighted-strike approach.
- This review fixes identified, tested defects; it does not establish that every possible
  production bug has been eliminated.
