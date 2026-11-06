# Droid adapter

These rules extend [`../../AGENTS.md`](../../AGENTS.md).

- The runtime is Droid's own ACP server, `droid exec --output-format acp` — one persistent
  process per Agent session on the shared `AcpSession` machinery. Verified on droid 1.4.1:
  `initialize` advertises `loadSession` with `sessionCapabilities` `list`, `resume`, `close`,
  `fork`, `auth.logout`, and auth methods `device-pairing` and `factory-api-key`. The launch
  asserts `loadSession` and refuses with `DroidUnsupportedOptionError` when absent.
- Standing instructions ride the CLI's own `--append-system-prompt-file`: the provider writes
  a private file (0700 directory, 0600 file) under the system temporary directory — never into
  the Agent workspace — and the session removes it when it ends. The alternative,
  `--append-system-prompt <text>`, would put the briefing in argv where any process table
  shows it.
- The CLI floor is 1.4.1 (`acp-version.ts`), the build the whole surface was verified on.
  `droid --version` prints a plain dotted version.
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
- Plan usage has no machine-readable surface (no ACP field, no CLI flag, no public endpoint),
  so `readUsage` drives the interactive TUI: spawn `droid` in a 160x40 PTY (`DROID_USAGE_SCREEN`
  — at the transport's 120-column default the panel collapses to unreadable bars), send
  `/limits`, Tab through the pool tabs, and parse the settled screens with `VtScreen`, the
  minimal VT buffer in `vt-screen.ts` — deliberately not a terminal emulator. Verified on
  1.5.0: Standard/Droid Core pools report 5-hour/Weekly/Monthly percentages with relative `↻`
  resets (minute precision, resolved against the capture instant; an unreadable phrasing omits
  `resetsAt`), Extra Usage reports a `$X.XX remaining` balance, and `You are using …` names the
  active pool. Any anomaly — missing header, window row, balance, or tab bar — throws
  unavailable rather than showing a wrong number; a sign-in screen is reauth. See `usage.ts`.
- Droid 1.4.1 sent no `compaction_update` in the verified turn, so `reportsCompaction` stays
  false; the reader still translates one if a later build publishes it (UNSTABLE ACP event,
  advertised through `acp/connection.ts`).
- Skills: the native project scope is `<workspace>/.factory/skills`, the personal one is
  `~/.factory/skills`, and both `.agents/skills` compatibility scopes are read too
  (<https://docs.factory.com/docs/harness/skills>). Verified on 1.4.1: a skill in each project
  directory appears in the session's skill list. Assigned skill packs install into the native
  `<workspace>/.factory/skills`.
- Sign-in has no non-interactive command: the auth adapter runs the interactive TUI in a PTY,
  reads the device flow's sentence (`https://auth.factory.ai/device` plus a `XXXX-XXXX` code),
  and confirms completion by re-reading `droid doctor --json --checks auth`. A
  `FACTORY_API_KEY` in the launch environment overrides stored credentials and cannot be
  signed out (`still_logged_in`). See `auth.ts`.
- A `tool_call_update` ends a call only through `acpToolUpdateEnded`; a status the set misses
  leaves the call open forever and suppresses stalled recovery.
