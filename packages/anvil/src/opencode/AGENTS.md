# OpenCode adapter

These rules extend [`../../AGENTS.md`](../../AGENTS.md).

- The runtime is the official `opencode acp` ACP server — one persistent process per Agent
  session on the shared `AcpSession` machinery. Verified on opencode 2.1.0: `initialize`
  advertises `loadSession` and session capabilities `resume`, `fork`, `list`, `close`,
  `delete`, `additionalDirectories`. The launch asserts `loadSession` and refuses with
  `OpenCodeUnsupportedOptionError` when absent.
- Standing instructions ride the process environment, never an ACP field: opencode has no
  system-prompt channel, so the provider writes a private instructions file (0700 directory,
  0600 file, deleted when the session ends or the launch fails) and sets
  `OPENCODE_CONFIG_CONTENT` to `{"instructions":["<absolute path>"]}` on the session process.
  From 2.0.30 on, OpenCode appends that file after the project's `AGENTS.md`. Do not set
  `agent.<name>.prompt` (that replaces the system prompt) and do not set
  `OPENCODE_CLI_CONFIG_CONTENT` (that overlays `cli.json`). If `OPENCODE_CONFIG_CONTENT` is
  already present in the Agent environment, the runtime `envVars`, or the process environment,
  refuse to start — do not overwrite or merge it. Nothing is written into the Agent workspace.
- The CLI floor is 2.1.0 (`acp-version.ts`), the version the whole ACP surface was verified on
  — `session/load` restore, the `model`/`thought_level` selects, the `-32602` missing-session
  answer, the `-32603` busy-prompt refusal. 2.0.30 is the instructions-channel floor only; the
  ACP surface between 2.0.30 and 2.1.0 is unverified, so the floor is the verified version.
- Resume is `session/load`; `-32602` with a "session not found" message means the stored
  session is gone and is replaced with a fresh one reported as `replaced`. Any other load
  failure surfaces. The adapter does not rely on `session/cancel`: interrupt is process
  disposal, and the daemon relaunches on the same session id.
- Input is one native prompt at a time (`after_turn`): a second `session/prompt` while a turn
  runs is refused with `-32603 "Session already has an active ACP prompt"`, so queued input is
  admitted when the live turn ends. A terminal RPC failure is an accepted failed turn, never
  an admission refusal.
- Model and effort apply through `session/set_config_option` after the session opens —
  `session/new` (and `session/load`) return the `model` select with `provider/model` values,
  and a `thought_level` `effort` select after a model applies. `runtime.model` fails with
  `RuntimeModelNotFoundError` when the select lacks it; a missing effort option leaves the
  model's own default, and a present option that lacks the value fails. `session/set_mode` is
  never called — opencode defaults to `build` and no launch field carries a mode.
- The model catalog is `session/new`'s `model` config option (`acp-catalog.ts`), not
  `opencode models`. Discovery is a full probe session: version gate, `initialize`,
  `session/new`, dispose.
- A `tool_call_update` ends a call only through `acpToolUpdateEnded`; a status the set misses
  leaves the call open forever and suppresses stalled recovery.
