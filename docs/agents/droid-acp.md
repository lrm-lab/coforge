# Droid ACP behavior

Part of [the documentation index](../../README.md). The Droid adapter runs one persistent `droid exec --output-format acp` process per Agent session. Moved verbatim from `packages/anvil/src/droid/AGENTS.md`.

- The runtime is Droid's own ACP server, `droid exec --output-format acp` — one persistent
  process per Agent session on the shared `AcpSession` machinery. Verified on droid 1.4.1:
  `initialize` advertises `loadSession` with `sessionCapabilities` `list`, `resume`, `close`,
  `fork`, `auth.logout`, and auth methods `device-pairing` and `factory-api-key`. The launch
  asserts `loadSession` and refuses with `DroidUnsupportedOptionError` when absent.
- Resume is `session/load`; `-32602` with "Unknown session identifier" means the stored session
  is gone and is replaced with a fresh one reported as `replaced`. Any other load failure
  surfaces. `session/cancel` is `-32601`: interrupt is process disposal, and the daemon
  relaunches on the same session id.
- Input is one native prompt at a time (`after_turn`): the server has no steer request, so a
  notice is queued and admitted when the live turn ends.
- Model and effort apply through `session/set_config_option` after the session opens —
  `session/new` and `session/load` return the `model` select (`auto`, `claude-*`, `gpt-*`
  ids) and the `reasoning_effort` select under `category: "thought_level"`, plus the
  `autonomy_level` `mode` select. `runtime.model` fails with `RuntimeModelNotFoundError` when
  the select lacks it; a missing effort option leaves the model's own default, and a present
  option that lacks the value fails. No launch field carries a mode, so `autonomy_level` is
  never written and the session keeps the server's default (`auto-medium`).
- Every answered turn carries `usage_update` (`{"used":348,"size":250000}` on a one-word
  prompt, verified on 1.4.1); the turn reader maps it to `context-usage`. That reading is the
  context window, never plan usage.
- Droid 1.4.1 sent no `compaction_update` in the verified turn, so `reportsCompaction` stays
  false; the reader still translates one if a later build publishes it (UNSTABLE ACP event,
  advertised through `acp/connection.ts`).
- Skills: the native project scope is `<workspace>/.factory/skills`, the personal one is
  `~/.factory/skills`, and both `.agents/skills` compatibility scopes are read too
  (<https://docs.factory.com/docs/harness/skills>). Verified on 1.4.1: a skill in each project
  directory appears in the session's skill list. Assigned skill packs install into the native
  `<workspace>/.factory/skills`.
