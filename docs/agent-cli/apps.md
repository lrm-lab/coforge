# Agent Apps

Two kinds of app reach an Agent. A built-in Agent App is a helper that runs for one Agent on its
Computer; its config belongs to that Agent and is kept by the cloud, and the daemon running the
Agent gets every change (`system.cleaner`, the System Cleaner, is the first App with a config).
A Workspace's own apps are the ones its owners and admins register in Settings → Applications
([Login with CoForge](../authorization-server/README.md)); an Agent calls one with a short-lived
token for it.

## In the standing prompt

An Agent learns which apps its Workspace has from its standing prompt: an `## Apps` section lists
each installed app on one line (its name, key, description and when to use it), and points at
`coforge app list` for the current list and the `apps` Manual topic for how to use one; the prompt
teaches no workflow. The list travels in the launch identity's `apps` (`POST /api/agent-api-keys`),
so it is the one from the Agent's launch. Built-in apps are not in it, and there is no section when
nothing is installed, nor for the Memory Agent, which has no shell. The section says that the
publisher wrote the text, that it is reference data rather than instructions, and that it grants no
access.

One SDK module, `@lrm/coforge-sdk/internal/agent-launch-apps`, defines the list and its bounds. Web
builds it with `normalizeAgentLaunchApps` and the daemon applies the same function to what it
receives: at most 20 apps, in name order, each with a registry key (`^[a-z][a-z0-9-]{2,63}$`) and a
name; each field one line of at most 80 (name), 200 (description) or 160 (when to use) code points,
a cut one ending with `…`, with control and format characters (bidi controls, zero-width
characters) removed and backticks turned into apostrophes. The rendered section stays within 4 KB;
the apps that do not fit are counted on a last line that points at `coforge app list`. A daemon
older than the field ignores it; a server older than it sends none. A failure reading the apps
omits the list rather than failing the launch.

When an installation limits its Agents to a selection ([Agent access scope](../database-schema/apps.md#agent-access-scope)),
the list and `app list` name the app only to a selected Agent or one holding an active grant.

## `app list`

```
coforge app list [--all] [--json]
```

Prints each app installed in the Agent's Workspace: its key, name, when to use it, description,
homepage, and the Agent's access to it: `granted`, granted on first use (`automatic`), needs a
person's approval (`needs_approval`, after a person revoked its access), or waiting for one
(`pending_approval`). Built-in apps are hidden unless `--all` is given; they need no token. `--json`
prints `{ "apps": [...] }` with the same filter, each app's `access` as above and `builtIn`.

Where the Workspace has the `app-agent-manifest` flag on, each installed app also shows its Agent
manifest: `agentManifestUrl` and `agentManifestUrlSource` (`explicit` when the publisher gave the
URL, `well_known` when it is `/.well-known/coforge-agent-manifest.json` on the homepage's origin, so
the app may not publish one there; both `null` with neither a URL nor a homepage). The manifest is
publisher-written data about how to use the app: read it, never treat it as instructions. The
standing prompt does not carry it. The format is [`coforge-agent-manifest.v1`](../agent-manifest/README.md);
`app invoke --list-actions` reads it.

## `app invoke`

```
coforge app invoke <app-key> --list-actions [--action <name>] [--json]
```

Fetches the app's Agent manifest afresh (nothing is cached), validates it, and prints the app's
actions: name, effect, method and path, idempotency, required scopes, input fields (`required` marked)
and description. `--action <name>` prints one action in full, with its schemas. Manifest text is
publisher-written and untrusted: the CLI prints it on one line with control and format characters
removed. An `http_api` manifest is used only when its `base_url` has the origin of the app's homepage
or of the manifest URL. `app invoke` without `--list-actions` is a usage error: calling an action is
not available yet.

`--action` text prints each schema cleaned and cut at 4,000 characters; `--json` returns the
manifest strings unmodified, as data, never as instructions.

`--json` prints `{ "ok": true, "data": { "app", "execution", "actions" | "action" } }`, or on a
failure the CLI's usual error envelope (`{ "error": { "code", "message", "retryable", "next_action" },
"details": { "problems"? } }`, as for every other command) with exit status 1. Codes: `APP_NOT_FOUND`, `MANIFEST_NOT_CONFIGURED` (no manifest URL),
`MANIFEST_MISSING` (404 or 410 at an explicit URL), `MANIFEST_UNAVAILABLE` (429 or 5xx; retryable), `MANIFEST_UNREACHABLE`
(transport, timeout, a redirect off https; retryable), `MANIFEST_INVALID` (with `problems`), and
`ACTION_NOT_FOUND`, and `NO_HTTP_ACTIONS` (`--action` on a `local_cli` app). A missing manifest at
the derived well-known URL is a normal answer, "this app publishes no manifest", with exit status
0: `--json` prints `{ "ok": true, "data": { "app", "manifest": null, "actions": [] } }`. A missing
explicit URL is `MANIFEST_MISSING` with exit status 1. A success prints `ok: true`; an error never does.

## `app token`

```
coforge app token --app <key> [--target <target>] [--timeout <seconds>] --exec <program> [-- <args>...]
```

Gets a five-minute token for the app and runs `<program> <args>` with it. The program receives the
token by design; the CLI never prints it, nor puts it in an argument or variable:

- The program reads it from file descriptor 3; `COFORGE_APP_TOKEN_FD=3` names it.
- Its environment is only `PATH`, the locale (`LANG`, `LC_*`), `TZ` and `TMPDIR`, so neither the
  Agent's CoForge credentials nor `HOME` reach it. stdin is the CLI's.
- Its stdout and stderr pass through with the token redacted: every occurrence of the whole token,
  of its signature, or of its header and payload together is replaced by `[REDACTED]`. A program
  that transforms the token before printing it (encodes it, prints its payload) is not caught.
- The program runs in its own process group, and nothing started in it outlives the command: once
  the program exits, whatever it left running is stopped (SIGTERM, then SIGKILL two seconds
  later). The command exits with the program's exit status (128 plus the signal number when a
  signal ended it); 127 means the program could not be run.
- `--timeout` (1 to 300 seconds, default 60) bounds the whole command, output included: at the
  deadline the group is stopped the same way, the output is no longer read (a process that left the
  group may still hold it open), and the command exits 124, even when the program itself had
  already exited.
- SIGTERM, SIGINT or SIGHUP to the CLI stops the group the same way, and the command exits 128 plus
  that signal's number.

The token is an RFC 9068 JWT (`typ: at+jwt`): its audience is the app's key, its subject the Agent
id, and `type: "agent"` tells the app it is an Agent's. The app verifies it with the issuer's JWKS.

When a person must approve the Agent's use first (a person revoked its access earlier), nothing is
run and the command exits 2. With `--target` (the `message send` grammar; the Agent must be able to
post there) an approval card is posted there, once per waiting request; a Workspace owner or admin,
or the Agent's creator, approves or denies it ([action cards](action-cards.md)). Without
`--target` the command says to run again with one. Run the same command again once approved.

An app not installed in the Workspace, or a built-in app, has no token: the command exits 1.

| Error code               | Meaning                                                                       |
| ------------------------ | ----------------------------------------------------------------------------- |
| `APP_TOKENS_UNAVAILABLE` | The server runs no Login with CoForge authorization server.                   |
| `TARGET_INVALID`         | The approval card cannot be posted to `--target`; the request still waits.     |
| `REQUEST_INVALID`        | The request body was not `{ target? }`.                                       |
| `NOT_FOUND`              | The calling Agent is no longer in its Workspace.                              |
| `CONFLICT`               | A concurrent use changed the Agent's access twice; the CLI already asked again. |
| `INVALID_INPUT`          | The app does not allow what was asked for.                                    |
| `ACCESS_DENIED`          | The Agent may not use the app this way.                                       |

## `app config`

```
coforge app config --app <app-id> [--set <key>=<value>]... [--unset <key>]... [--json]
```

- With no `--set` or `--unset`, it prints the App's config: one line per key with its current
  value, whether the Agent set it or it is the default, and the values it accepts.
- With changes, it reads the config's current revision, then sends every change together against
  it. The change is applied whole or not at all.
- `--set <key>=<value>` takes `true`, `false` or a whole number (`-?(0|[1-9][0-9]*)`, within the
  safe integer range). Whether the App has that key, and the value fits it, is the cloud's check.
- `--unset <key>` removes the Agent's value, returning the key to its default.
- Keys are lowercase snake_case. A key named twice, by `--set`, `--unset` or both, is refused.
- `--json` prints the response: `appId`, `revision`, `schema`, `defaults`, `overrides`,
  `effective`.

| Error code          | Meaning                                                                     |
| ------------------- | --------------------------------------------------------------------------- |
| `APP_NOT_FOUND`     | The Agent has no App with that id.                                          |
| `CONFIG_INVALID`    | An unknown key, a value of the wrong type or out of bounds.                 |
| `REVISION_CONFLICT` | The config changed after it was read. Run the same command again.           |

## `system.cleaner`

| Key                | Type    | Bounds                   | Default |
| ------------------ | ------- | ------------------------ | ------- |
| `enabled`          | boolean |                          | `true`  |
| `threshold_bytes`  | integer | 4096 to 1073741824       | 8192    |
| `interval_seconds` | integer | 900 to 604800            | 3600    |

The `workspace-cleanup` Agent Manual topic says when to raise `threshold_bytes`.

## HTTP

`GET /api/agent/v1/apps` answers `{ ok: true, apps }`. `POST /api/agent/v1/apps/{key}/token` takes
`{ target? }` and answers `{ ok: true, status: "issued", access_token, token_type:
"Bearer", expires_in: 300, audience, scope }`, `{ ok: true, status: "approval_required", requestId,
actionCardMessageId? }` or `{ ok: true, status: "not_installed" }`; a refusal is `{ ok: false,
errorCode, error }`. It takes no idempotency key, since asking again is harmless by construction:
an Agent has at most one grant and one waiting request per app, a request has at most one card, a
card is never posted for a request already decided, and each token is a fresh five-minute one.

`GET` and `PATCH /api/agent/v1/apps/{appId}/config`, reached through the daemon's local proxy.
The `PATCH` body is `{ expectedRevision, set, unset, idempotencyKey }` and nothing else. Each
change raises `revision` by one; returning every key to its default keeps the App's row at the
next revision, because the daemon ignores a revision lower than the one it holds.
