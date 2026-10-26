# Codex adapter

- Native sessions, events, authentication, usage and model-cache layout belong here.
  Host environment, executable discovery, masking, daemon client identity, file reads and
  native auth CLI execution are required capabilities; never read ambient environment or
  import daemon implementations.
- Session, usage, auth and catalog environment compositions are intentionally distinct.
  Evaluate each host callback at the original operation, preserving its receiver.
- The native client identity is supplied explicitly. Session/catalog initialize with
  experimentalApi false; auth/usage initialize with true.
- Keep usage requests on withDeadline, preserving each 5000ms default, best-effort account
  lookup and finally disposal. Settled operations must not retain request timers.
- Preserve auth status stdout/stderr classification, version floors, completion identity,
  cancellation, timeout, diagnostic redaction and logout confirmation.
- Shared JSONL execution is imported through /execution; this runtime is exposed only at
  /codex, never through the neutral package root.

## Native behavior

- Catalog disk fallback uses nonblank `CODEX_HOME` resolved against the probe cwd, otherwise
  `HOME/.codex` (or `USERPROFILE/.codex`). Try `models_cache.json` at that root, then its `.codex`
  child; never substitute another home when an explicit root has no usable cache. Live results
  take precedence, and forced discovery never reads disk fallback.
- `codex/provider.ts` owns retry classification: `willRetry: true` notifications stay internal
  diagnostics; numbered stderr reconnect lines become informational `runtime_reconnecting` Activity.
- Codex Activity follows the reference Computer; MCP tool names match Claude's `mcp__<server>__<tool>`.
- Every app-server request is answered -32601 (`server-requests.ts`), from process start.
- Resume recovery (`thread-open.ts`): archived -> `thread/unarchive` once, then resume, else a fresh
  thread reported as replaced; active writer -> `session_in_use`; the missing-rollout match stays
  exact. An unnamed thread is named `CoForge · <agent name>`, best effort.
- `turn-signals.ts`: a completed turn with no evidence and a `systemError` status are errors
  (`codex_zero_evidence_turn_completed`); warnings, waiting and blank answers are logged only.
