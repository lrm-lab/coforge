# Registering and managing an app as an Agent

An Agent can ask for an app to be registered and then manage it. Registering is a card a person
commits, as with every other [action card](action-cards.md); the Agent never registers anything on
its own. The app is the Workspace's, like one registered in Settings → Applications
([Login with CoForge](../authorization-server/README.md)); the Agent that asked becomes its
**owner Agent**, one per app, an additional manager beside the Workspace's owners and admins.

This follows Raft's `raft integration app prepare register` flow. The differences are at the end.

## `app prepare register`

```
coforge app prepare register --target <target> --name <name>
  [--redirect-url <url>]... [--client-key <key>] [--homepage-url <url>] [--description <text>]
  [--when-to-use <text>] [--category <category>] [--agent-manifest-url <url>]
  [--scope <scope>]... [--draft-hint <text>]
```

Posts an `app:register` card into `<target>` (the `message send` grammar; the Agent must be able to
post there). Any Agent may prepare one. It registers nothing. The card shows every field: the name,
the client key (or "Auto-generated on commit"), the redirect URLs, the app URL, the Agent manifest
URL, the description, when to use it, the category and the scopes. It never shows a secret.

- `--redirect-url` and `--scope` repeat. `--scope` adds a Login scope (`email`) to the fixed ones
  (`openid`, `profile`, `identity`). `--category` defaults to `other`.
- The server checks every value with the app registry's own input rules when the card is prepared,
  and refuses the card, naming the flag (`INVALID_ACTION`, `field: --redirect-url`), if it could
  never be committed. A client key that is already taken is `APP_EXISTS` (409).
- It prints the card's message id and what happens next. It has no `--json`.

A **Workspace owner or admin** commits the card in the web app; a member is refused and sees why.
Committing registers the app in that Workspace, installs it there, makes the preparing Agent its
owner Agent and marks the card `executed` ("Committed by <person>"), all in one transaction. A card
commits once; a second commit is refused. If the Agent was archived before the commit, or its row is
hard-deleted afterwards (`ownerAgentId` is set null), the app has no owner Agent: no secret is sent,
the card says so, and a Workspace owner or admin (or an admin-role Agent) regenerates the secret in
Settings → Applications (Regenerate secret).

## `app status`

```
coforge app status (--card <message-id> | --client <key>) [--json]
```

`card_pending`: the card waits for an owner or admin. `committed`: the app exists (with
`--client`, only an app this Agent may manage). `cancelled`: the card was dismissed. A card another
Agent prepared, an unknown card, and an app this Agent may not manage are `NOT_FOUND`.

## `app list --owned`

```
coforge app list --owned [--json]
```

The Agent's register cards that still wait, and the apps it owns (`role: owner`). An Agent whose
server role is `admin` also sees every app of its Workspace (`role: admin`), as Raft's admin Agents
do. `app list` without `--owned` keeps its meaning: the installed apps and the Agent's access to
them. `--json` prints `{ "pending": [...], "apps": [...] }`.

## The client secret

The secret never goes into the card, a message, a log or a database row; the server keeps only its
SHA-256 hash. When the card is committed, the server sends the owner Agent **one private notice**,
once:

- It goes to the daemon on the Computer running the Agent, over the daemon WSS (the control
  channel), and only if that daemon's ready advertised `app-registration-notice:v1`. The wire is
  `AppRegistrationNotice` (`app_registration.proto`); a message of another type is never taken for
  it. There is no retry, no spool and no acknowledgement.
- The daemon drops it unless the Agent is running. Otherwise it keeps the secret in memory as one
  transient App Inbox item (`system.app_registry`, class `client_secret`), never on disk and never
  in a log, tells the Agent an item is waiting, and forgets it after 15 minutes or when the
  process ends. The Agent reads it with `coforge inbox check`, and **that read consumes it**: the
  item is gone from the next check. The 15 minutes only bound an item nobody read. Activity text
  and the daemon's failure details redact any `cfa_secret_…` value.
- Store it in a file at once; never post it in chat. The notice says so.

If the notice was missed (Agent offline or stopped, a daemon that predates the capability, the
15 minutes passed), rotate the secret.

## `app rotate-secret`

```
coforge app rotate-secret --client <key> --output <new path> [--json]
```

The app's owner Agent, or an admin-role Agent of the same Workspace, may rotate, and only while
that Agent is not archived (checked on every call). Anyone else is refused.
It writes a **new** secret to `--output` and nowhere else:

1. It refuses Windows (`UNSUPPORTED_PLATFORM`): the file cannot be made private there.
2. It creates the file first, exclusively (`O_CREAT | O_EXCL`, mode 0600). An existing path, a
   link included, is `OUTPUT_EXISTS`, and nothing is rotated. Pick a new path.
3. It asks the server to rotate. The previous secret stops verifying at once (the token endpoint
   answers `invalid_client` for it). If the request fails, the empty file is removed.
4. It writes the secret and a newline. If the write fails the secret is lost and the previous one is
   already invalid: the command says so, names the file, and tells the Agent to remove it
   (`rm <path>`) and run the command again.

The secret is printed on neither stdout nor stderr, and is in the response body only. An
app the Agent may not manage, an unknown one, and one of another Workspace are all `NOT_FOUND`, so
an app is not confirmed to exist.

## HTTP

Reached through the daemon's local proxy, `POST /api/agent/v1/app-registrations` with the body
`{ operation: "register_status" | "owned_list" | "rotate_secret", ... }` (the same operation names
from the CLI to the cloud). The daemon forwards each with the Agent's key:

| Operation                | Cloud route                                                 |
| ------------------------ | ----------------------------------------------------------- |
| prepare                  | `POST /api/agent/v1/actions/prepare` with an `app:register` action |
| `status`                 | `GET /api/agent/v1/apps/registrations/status?card=` or `?client=` |
| `owned`                  | `GET /api/agent/v1/apps/owned`                              |
| `rotate_secret`          | `POST /api/agent/v1/apps/owned/{key}/rotate-secret`         |

Errors are `{ ok: false, errorCode, error }` as for `app token`. The rotation answer is
`{ ok: true, clientKey, clientSecret }` with `cache-control: no-store`.

## Differences from Raft

- **Secret delivery** is Raft's private transient notice, over the daemon WSS; the fallback is Raft's
  `rotate-secret --output`.
- **No `--setup-url` / `--setup-description`**: an app's setup page is declared in Settings
  (`app-installation-setup`), not on the card. `--when-to-use` is CoForge's one-line hint to Agents.
- **Redirect URLs are optional**: Login with CoForge needs at least one to sign a person in, but an
  Agent-only app may omit it. Raft requires one.
- Not built yet: update, logo, transfer-owner, recover-owner, delete, share links and publish
  requests from the CLI.
