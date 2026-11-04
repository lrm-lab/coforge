# Antigravity adapter instructions

- The runtime is `agy acp`, the ACP server inside the `agy` CLI — one persistent ACP process
  per Agent session. It shares agy's own sign-in: no separate credential store, and the SSH
  session-marker rules below apply to every `agy` process the Daemon starts.
- Launch floor `agy --version >= 1.5.0` (`acp-version.ts`), the first release shipping `agy acp`.
  A launch asserts `agentCapabilities._meta.antigravity.systemPrompt.append` on `initialize`
  (verified on 1.5.0) and refuses with `UnsupportedOptionError` when absent — no fallback. The
  version gate also runs before catalog discovery spawns a process; a below-floor agy is an
  upgrade prompt, not a failed launch, and an unreadable version never gates.
- Standing instructions ride the `session/new`/`session/load` envelope as
  `_meta.antigravity.systemPrompt.append`; `disabledTools` in the same envelope is the optional
  host tool filter. `session/set_mode` `yolo` and the model (`model`) and effort
  (`thinking_level`) `session/set_config_option` calls replay on every open — a resumed session
  starts at the default mode. Every open request is deadline-bounded.
- Resume is `session/load`; `-32002` means the stored session is gone and is replaced with a
  fresh one reported as `replaced`. Any other load failure surfaces. A session survives the
  process: a killed `agy acp` resumes through `session/load` on a fresh process (verified on
  1.5.0). `session/cancel` is unimplemented — interrupt is process disposal
  (`profile.cancelTurn`), and the daemon relaunches on the same session id.
- Input during a live turn is a second `session/prompt` — the server's steer path, so delivery
  is `direct`. Verified on 1.5.0: the steered prompt resolves `end_turn` with the merged turn's
  usage when the turn ends, and the first prompt resolves `end_turn` too — not `cancelled`. A
  steered turn is one merged turn: every prompt's updates join the one turn reader and
  `completed` fires once when the last prompt resolves. A steer answer with any other
  `stopReason` (`max_tokens`, `max_turn_requests`) still means the text reached the model; only
  `cancelled`/`refusal` (or a missing `stopReason`) reports `notice-undelivered`, which lets the
  daemon redeliver once idle. A steer whose answer never arrives holds the turn open until
  interrupt — there is no watchdog on the merged turn's length.
- A terminal RPC failure after prompt submission is an accepted failed turn, not an admission
  refusal; a process kill during `interrupt()` reports `completed{interrupted}` without the
  transport's own "connection closed" error.
- The model catalog is `session/new`'s `model` config option (`acp-catalog.ts`), not
  `agy models`. Per-turn usage is not reported through ACP prompt responses in a shape the
  adapter can attribute per turn — the steer's `usage` covers the merged turn; account usage
  reads `agy -p /usage --output-format json`, which answers without a turn.
- `SSH_CLIENT`, `SSH_CONNECTION`, `SSH_TTY` never reach an `agy` process: agy switches to a
  file-based token store when it sees them (logs "Using file-based token storage because %s
  detected"; not in the public docs). The Daemon strips them from inherited and declared inputs
  before an Agent's own overrides; an explicit override still applies.
- A `tool_call_update` ends a call only through `acpToolUpdateEnded`; a status the set misses
  leaves the call open forever and suppresses stalled recovery.
