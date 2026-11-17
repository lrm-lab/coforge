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
