# Action cards

`coforge action prepare --target <target>` posts a typed "action card" — a
proposed change a human later commits under their own identity — into
`<target>` (the same `#channel[:thread]` / `@user[:thread]` grammar as
`message send`; the Agent must already be a member). The card's JSON body is
read from stdin, either a real shell heredoc or a literal body whose first
and last lines are the delimiter `COFORGEACTION`, or raw JSON with no delimiter:

```
coforge action prepare --target "#design" <<'COFORGEACTION'
{"type":"channel:create","name":"design","visibility":"public"}
COFORGEACTION
```

As with `message send`, stdin redirected from a regular file another user owns
fails with `STDIN_FILE_NOT_OWNED` before any request.

An Agent prepares four kinds; the other `integration:*` kinds are not implemented
yet:

- **`channel:create`**: `name` (1-32 chars, `^[a-z0-9][a-z0-9_-]{0,31}$` after
  trimming a leading `#`), `visibility` (`public` or `private`; `private`
  is accepted by validation but rejected by the server — not supported
  yet), `description?` (≤500 chars), `initialHumans?`/`initialAgents?`
  (≤64 handles or UUIDs each), `draftHint?` (≤2000 chars).
- **`agent:create`**: `name` (`^[a-z0-9]+(?:-[a-z0-9]+)*$`, ≤64 chars),
  `description?`, `suggestedComputer?`, `requiredComputer?` (handle or
  UUID; at most one of the two), `draftHint?`. No `runtime`, `model`, or
  `reasoning` field — those stay human-picked.
- **`channel:add_member`**: `channel` (handle or UUID), `humans?`,
  `agents?` (at least one of the two non-empty), `draftHint?`.
- **`app:register`**: `name`, `clientKey?`, `redirectUrls?`, `homepageUrl?`, `description?`,
  `whenToUse?`, `category?`, `agentManifestUrl?`, `scopes?`, `draftHint?`; prepared by
  `coforge app prepare register`. A Workspace owner or admin commits it, which registers the app with
  the preparing Agent as its owner Agent; the server checks each value with the app registry's rules
  when preparing it, and the card never carries a secret ([registering an app](app-registration.md)).
- **`app:recover_owner`**: `clientKey`, `toAgent` (a live public Agent of the Workspace), `draftHint?`;
  prepared by `coforge app prepare recover-owner`. Only an admin-role Agent that manages the app may
  prepare it, and only while the app has no live owner Agent. A Workspace owner or admin commits it
  ([managing an app](app-management.md)).

Identity fields (`initialHumans`, `initialAgents`, `suggestedComputer`,
`requiredComputer`, `channel`, `humans`, `agents`) are handles the Agent
already knows — `@alice`, `alice`, `#general`, `general` — or a UUID; the
server resolves each one at prepare time and fails the whole request, naming
the field, if any handle does not resolve. The Agent never invents a database
id.

Local zod validation, then `validateActionCardAction`'s cross-field rules
(`agent:create` may set at most one of `suggestedComputer`/
`requiredComputer`; `channel:add_member` needs at least one human or
agent), run before the request is sent; a failure is reported as
`Action failed validation: <path>: <message>; …`. The server checks the whole
action again and refuses in the same form: `INVALID_ACTION` (with the issues),
`INVALID_HANDLE` (naming the field; a private Agent the caller can see is
refused because it "cannot be a channel member"), `AGENT_NOT_VISIBLE` (a
private Agent the caller cannot see, as channel management answers it),
`CHANNEL_EXISTS`, `AGENT_EXISTS`, `APP_EXISTS`, `APP_OWNER_ACTIVE` (an `app:recover_owner` for an app that still has a live owner Agent), or, as
for `message send`, `DM_PEER_NOT_IN_WORKSPACE` and `TARGET_NOT_ACCESSIBLE`. The
CLI reports its reason, code and next step. On success the CLI prints:

```
Action card posted to <target> as message <uuid> (short <first 8>). The human can click the action verb to commit.
```

Posting a card only records it as an ordinary Agent message; it never creates
the channel, Agent, or membership itself. A human commits the card from the
CoForge Web UI, not from any CLI command: they click the card's action
button, review a form prefilled (and editable) from the card's values, and
submit it under their own identity. To check whether that happened, read the
card message again — its body carries a suffix the Agent-facing message read
appends, `[action card: pending]`, `[action card: executed]`, or
`[action card: cancelled]`:

```
coforge message read --target "#design" --around <message-id>
```

Only `executed` means the resource now exists.

## App approval cards

The server posts one more kind itself, never through `action prepare`: `app:grant_agent`, when
`coforge app token --target <target>` finds that a person must approve the Agent's use of an app
([Agent Apps](apps.md)). It is posted once per waiting request, wherever the first `--target`
named, and carries the request, the app and the scopes. A Workspace owner or admin, or the Agent's
creator, commits it (Approve), which approves the request under the same rule as the Agent's Apps
settings, or cancels it (Deny), which denies the request; the generic Dismiss does not apply to it.
A request approved or denied in the Agent's Apps settings settles its card the same way.
Read back, the card shows `[action card: executed]` once approved and `[action card: cancelled]`
once denied; run `coforge app token` again after an approval.
