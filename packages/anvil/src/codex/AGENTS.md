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
- Reasoning summaries (`reasoning-summary.ts`): a launch asks for `model_reasoning_summary: "auto"`
  unless the user's `$CODEX_HOME/config.toml` assigns the key, top level or in a profile. Several
  models default to `none`, and their thinking then arrives with no readable text.
- `turn-signals.ts`: a completed turn with no evidence and a `systemError` status are errors
  (`codex_zero_evidence_turn_completed`); warnings, waiting and blank answers are logged only.
- Idle recycle reads `$CODEX_HOME/sessions/**/rollout-*-<threadId>.jsonl` through the history host.
  An absolute `CODEX_HOME` on the Agent wins; a relative one is ignored. Facts are the last
  record's timestamp and the last `event_msg` `token_count`'s `info.last_token_usage.input_tokens`.
  The briefing is recent `response_item` messages and tool calls, inside the caller's token budget.
  Anything unreadable resumes the old session. The cold gap is 30 minutes
  (`CODEX_IDLE_RECYCLE_MIN_COLD_GAP_MS`). The JSONL shape is Codex's internal rollout
  (`RolloutLine` / `RolloutItemWire`, openai/codex main on 2026-10-28), not a stable API.
