# Codex adapter

Read [Codex app-server behavior](../../../../docs/agents/codex-app-server.md) when changing Codex's reset credit, catalog fallback, retry, resume recovery, turn signals, idle recycle or context usage.

- Native sessions, events, authentication, usage and model-cache layout belong here.
  Host environment, executable discovery, masking, daemon client identity, file reads and
  native auth CLI execution are required capabilities; never read ambient environment or
  import daemon implementations.
- Session, usage, auth and catalog environment compositions are intentionally distinct.
  Evaluate each host callback at the original operation, preserving its receiver.
- The native client identity is supplied explicitly. Session/catalog initialize with
  experimentalApi false; auth/usage/reset-credit initialize with true.
- Keep usage requests on withDeadline, preserving each 5000ms default, best-effort account
  lookup and finally disposal. Settled operations must not retain request timers.
- Preserve auth status stdout/stderr classification, version floors, completion identity,
  cancellation, timeout, diagnostic redaction and logout confirmation.
- Shared JSONL execution is imported through /execution; this runtime is exposed only at
  /codex, never through the neutral package root.

## Native behavior

- Reasoning summaries (`reasoning-summary.ts`): a launch asks for `model_reasoning_summary: "auto"`
  unless the user's `$CODEX_HOME/config.toml` assigns the key, top level or in a profile. Several
  models default to `none`, and their thinking then arrives with no readable text.
- A failed turn whose message or `additionalDetails` holds `invalid_encrypted_content`, or both `encrypted content` and `could not be decrypted or parsed` (any case), or whose `code` is `invalid_encrypted_content`, sets `sessionRecovery: "provider_replay_rejected"` on its `error` event (`turn-outcome.ts`, openai/codex#17541). Codex's `TurnError` has no `code` of its own (app-server schema 0.167.0); the API text is in `message`/`additionalDetails`. Match nothing wider (the bare phrase also names a gateway's header): the daemon invalidates the stored thread on it.
