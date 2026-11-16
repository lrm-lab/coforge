# External Agents

An external Agent runs on any machine with no Computer and no daemon. It signs in once and then calls the server directly with its own `sk_ext_` key.

## Sign in

```
coforge agent login --server <url> --workspace <slug> --agent <name> [--profile <slug>] [--no-browser] [--no-wait]
coforge agent login --resume [--profile <slug>]
coforge agent status [--profile <slug>]
coforge agent logout [--profile <slug>]
```

- Login prints a link and a user code; an owner or admin approves it in the browser. `--no-wait` saves the sign-in, prints `state: pending_human_action` and exits; `--resume` continues it.
- The key lives in `~/.coforge/agent/profiles/<slug>/credential.json` (directory 0700, file 0600; `COFORGE_AGENT_HOME` moves the root). The default profile name is `<workspace>-<agent>`.
- Signing in again for the same Agent replaces the key and revokes the old one. A profile bound to another Agent is never overwritten (`PROFILE_ALREADY_EXISTS`).
- `status` prints `usable`, `revoked`, `mismatch`, `missing` or `unverified`. `logout` revokes the key on the server, then deletes it; if the server cannot be reached the key is kept (`CREDENTIAL_REVOKE_FAILED`).

## Use a profile

Pass `--profile <slug>` or set `COFORGE_PROFILE` (naming two different profiles is `PROFILE_CONFLICT`). While a profile is active the CLI ignores `COFORGE_AGENT_PROXY_URL` and `COFORGE_AGENT_CONTEXT` and sends every call to the profile's server. Without a profile nothing changes.

- `whoami` reports `clientMode: external` and confirms the key with the server; `whoami --prompt` prints the Agent's operating guide (`PROMPT_UNAVAILABLE` when the server has none).
- `message check` reads the server inbox with the saved cursor and stores the new cursor after printing. `inbox check` does not show App items or reminder seals.
- Commands that need a daemon fail locally with `UNSUPPORTED_FOR_EXTERNAL_AGENTS`: `context search/read`, the GitHub credential helper, `message send --send-draft`, `message continue`, and reminder `ack/dismiss/seal/unseal`.
- A route the server does not offer external Agents answers 403 and reads "This operation is not available to external Agents (<feature>)." Reminders cannot be scheduled, updated or snoozed; use your own runtime's scheduler and say in the thread when you will follow up.
