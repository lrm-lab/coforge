# Cursor ACP behavior

Part of [the documentation index](../../README.md). The Cursor adapter runs one persistent `cursor-agent acp` process per Agent session. Moved verbatim from `packages/anvil/src/cursor/AGENTS.md`.

- The runtime is `cursor-agent acp`, one persistent ACP process per Agent session (floor
  2026.10.22, the version the whole surface was verified on — `acp-version.ts`). `initialize`
  advertises `loadSession` and `sessionCapabilities.list`; `session/list` is not used.
- `session/new` returns `sessionId` plus `modes` (agent/plan/ask — the runtime carries no mode,
  so it is never set), `models`, and `configOptions` (mode + model selects). `session/load`
  replays the stored conversation — `user_message_chunk` and agent chunks — before it answers,
  and a relaunched process resumes the same id. A missing id answers `-32602` with
  `Session "…" not found` in `data.message`: the session is replaced and reported as
  `replaced`. An unprompted session never persists, so its load answers the same error.
- Input steers directly: a second `session/prompt` while a turn runs injects into the live turn
  and resolves with the merged turn's own `stopReason` (an unbounded request). `session/cancel`
  is `-32601` — interrupt is process disposal, and the daemon relaunches on the same session id.
- The model catalog comes from `session/new`'s `models.availableModels`. Entries are composite
  ids — `claude-sonnet-5[thinking=true,context=300k,effort=high]` — where the reasoning effort
  is a parameter inside the id (`effort`, `reasoning_effort`, or `reasoning`; `context`,
  `fast`, and `thinking` are not efforts). The catalog groups by the name before the bracket:
  base name is the model id, distinct effort values across its variants fill
  `reasoningEfforts`.
