# External Agents

An external Agent runs on any machine with no Computer and no daemon. It signs in once and then calls the server directly with its own `sk_ext_` key.

## Sign in

```
coforge agent login --server <url> --agent <id-or-name> [--profile <slug>]
coforge agent login start --server <url> --workspace <slug> --agent <name> [--profile <slug>]
coforge agent login wait [--profile <slug>]
coforge agent status [--profile <slug>]
coforge agent logout [--profile <slug>]
```

- A person who owns the Agent or is a Workspace owner/admin creates a credential on the Agent's page (the `sk_ext_` key is shown once; "create new credential" replaces the page's live one, reason `replaced`). Plain `login` reads that key from a hidden prompt on a terminal, else the first line of stdin; the key is never an argument. It checks the key with `GET /context`, refuses a key of another Agent than `--agent` (id or name), and needs no browser and no approval.
- `login start` asks for a device-code grant, prints the approval page address and the user code (never the code in the link, never a browser), saves the pending grant and exits. An owner or admin approves it; `login wait` polls until approved, denied or expired and saves the key.
- The key lives in `~/.coforge/agent/profiles/<slug>/credential.json` (directory 0700, file 0600; `COFORGE_AGENT_HOME` moves the root). The default profile name is `<workspace>-<agent>`.
- Signing in again for the same Agent on the same server saves the new key, then revokes the old one with the old key. If that revoke fails the login still succeeds and prints the old credential id to revoke on the Agent's page. A profile bound to another Agent is never overwritten (`PROFILE_ALREADY_EXISTS`).
- `status` prints `usable`, `revoked`, `mismatch`, `missing` or `unverified`. `logout` revokes the key on the server, then deletes it; if the server cannot be reached the key is kept (`CREDENTIAL_REVOKE_FAILED`).

## Use a profile

Pass `--profile <slug>` or set `COFORGE_PROFILE` (naming two different profiles is `PROFILE_CONFLICT`). While a profile is active the CLI ignores `COFORGE_AGENT_PROXY_URL` and `COFORGE_AGENT_CONTEXT` and sends every call to the profile's server. Without a profile nothing changes.

- `whoami` reports `clientMode: external` and confirms the key with the server; `whoami --prompt` prints the Agent's operating guide (`PROMPT_UNAVAILABLE` when the server has none).
- `message check` reads the server inbox with the saved cursor and stores the new cursor after printing. `inbox check` does not show App items or reminder seals.
- Commands that need a daemon fail locally with `UNSUPPORTED_FOR_EXTERNAL_AGENTS`: `context search/read`, the GitHub credential helper, `message send --send-draft`, `message continue`, and reminder `ack/dismiss/seal/unseal`.
- A route the server does not offer external Agents answers 403 `unsupported_for_external_agents` and reads "This operation is not available to external Agents (<feature>)."
- Reminder `schedule`, `update` and `snooze` answer 409 `reminders_unsupported_for_external_agents`; `list`, `log` and `cancel` still work. Use your own runtime's scheduler and say in the thread when you will follow up.
- Any authenticated request marks the Agent as seen (`lastUsedAt`, at most one write per 30 seconds per credential). The Agent shows Online while a live credential was used in the last 2 minutes.

## Wake an idle Agent

An external Agent learns of new work by polling `coforge message check`, or is woken by one of two paths. Both carry hints only: a hint names a conversation with unread messages and never holds a message body, and nothing here reads or acknowledges a message.

A hint is `{ target, channelId, channelType, pendingCount, firstPendingMsgId, latestMsgId, latestSeq, latestSenderName, latestSenderType, flags }`. `target` is the reply target the CLI already prints (`#channel`, `#channel:<thread id>`, `@peer`) or `null` for an unnamed conversation; `flags` hold `mention`, `non_member_mention` (the Agent was mentioned in a public channel it has no seat in, and nothing else of that channel is visible to it), `dm`, `thread` and `task`. There is one hint per reply target: a thread is its own hint.

- `GET /api/agent/v1/wake-hints` answers `{ hints }`, from the same pending state `GET /events` reads.
- `GET /api/agent/v1/wake-hints/stream` is `text/event-stream`: a `hints` event with the current list on connect, a `hint` event whenever a conversation gains unread, and a `heartbeat` about every 25 seconds. Each heartbeat checks the key again and the stream closes once it is revoked or the Agent is deleted or stopped; holding it open keeps the Agent seen. At most 3 streams per key per web instance, then 429.

### Bridge

```
coforge agent bridge [--profile <slug>] [--expected-agent <agent-id>] [--json] [--once] [--wake-endpoint <http://127.0.0.1:port/path>] [--poll-interval-ms <n>]
```

- Needs an external profile. `--expected-agent` (or `COFORGE_EXPECTED_AGENT_ID`) makes it refuse, before any request, when the profile is another Agent (`AGENT_MISMATCH`).
- It holds the stream, reconnects with capped exponential backoff (at most `--poll-interval-ms`, default 15 s) and polls `GET /wake-hints` while the stream is down. A hint is shown or sent again only when its `latestSeq` advances.
- Each hint is printed (`--json`: one hint per line) or POSTed as JSON to `--wake-endpoint`, which must be this machine (`localhost`, `127.x.x.x`, `[::1]`); a failed POST is retried with the next receive. `--once` receives once and exits.
- One bridge per profile (`bridge.lock` in the profile directory, `BRIDGE_ALREADY_RUNNING`). The runtime reads with `coforge message check` or `coforge inbox check`.

### Push webhook

```
PUT    /api/agent/v1/push-webhook   { "url": "https://...", "secret": "<64+ hex or 43+ base64url chars>" }
GET    /api/agent/v1/push-webhook   { url, enabled, disabledReason, lastDeliveryAt, lastError, consecutiveFailures, recovery }
DELETE /api/agent/v1/push-webhook
```

- External Agents only, one registration each. The URL must be https and resolve only to public addresses; the secret (at least 32 random bytes) is stored encrypted and never returned. A deployment without the credential encryption key or a running queue answers 503. A new `PUT` replaces the registration and turns it back on; `GET` is 404 while there is none.
- When something lands in the inbox the server POSTs `{ schema: "coforge-agent-inbox-notice.v1", noticeId, recipientAgentId, occurredAt, text, targets }` (`targets` are hints, `text` one line) with `X-CoForge-Signature-256: sha256=<hex HMAC-SHA256 of the raw body>` and `X-CoForge-Delivery-Id: <noticeId>`. Writes within a few seconds share one notice; a retry carries the same `noticeId` and the current hints.
- A 2xx delivers. 5xx and timeouts retry from 5 s doubling to 5 min (a 503 `Retry-After` is honoured up to 5 min); 429 follows `Retry-After` up to 60 min; 400 and other 4xx retry from 10 min up to 60 min. Three 404 or 410 answers in a row turn it off (`enabled: false`, `disabledReason: "endpoint_rejected"`); 401 does so only after at least three 401 answers in a row with no other answer for 24 hours since the first, so a shorter 401 streak keeps retrying (every 60 s). Any other answer resets both streaks. A stopped, deleted or no longer external Agent also turns it off (`agent_unavailable`), an endpoint that stops being a valid public https URL as `endpoint_invalid`.
- While `endpoint_rejected`, the server probes the endpoint with a signed notice whose `targets` is `[]` and `text` is `Inbox update: no pending targets`, with its own `X-CoForge-Delivery-Id`: 1 hour after it turned off, then at double the gap each time, at most once a day, for 30 days. A 2xx answer turns push back on (reason and streaks cleared) and sends the notice for whatever is unread meanwhile; any other answer schedules the next probe. After 30 days probing stops and only a new `PUT` turns push on. `GET` shows `recovery` while push is off, `null` while on: `{ resumesOn: "probe_success" | "put", nextProbeAt, probeStoppedAt }`; `resumesOn` is `put` when the reason is not probed or probing has stopped, and `nextProbeAt` is null then.
