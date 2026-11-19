# Antigravity ACP behavior

Part of [the documentation index](../../README.md). The Antigravity adapter runs one persistent `agy acp` process per Agent session.

- The runtime is `agy acp --dangerously-skip-permissions --process-per-session`, the ACP server
  inside the `agy` CLI — one persistent ACP process per Agent session (and for model-catalog
  probes). `--process-per-session` runs an isolated per-session worker so HTTP MCP is advertised.
  Whenever `GEMINI_HOME` is non-empty in the launch environment, every `agy acp` invocation
  (session, catalog, auth and `agy acp --login`) forwards `--gemini-dir <GEMINI_HOME>` because
  `agy` ignores `GEMINI_HOME` on its own. It shares agy's own sign-in: no separate credential
  store, and the SSH session-marker rules below apply to every `agy` process the Daemon starts.
- The floor is agy 1.5.8 (`acp-version.ts`), from agy's changelog: `session/cancel` ends a prompt
  without stopping the next one from 1.5.1, the `auto` mode arrives in 1.5.4, and `usage_update`
  context readings in 1.5.8. Behavior below was verified live on 1.5.10.
- Standing instructions ride the `session/new`/`session/resume`/`session/load` envelope as
  `_meta.antigravity.systemPrompt.append`, appended to agy's own system prompt; agy still reads
  the Agent workspace's `AGENTS.md`/`GEMINI.md`. `session/resume` and `session/load` apply the
  append they carry, so a resumed session picks up changed instructions. `disabledTools` in the
  same envelope is the optional host tool filter. `mcpServers` is intentionally kept empty (`[]`)
  because agy persists ACP `mcpServers` entries and headers in plaintext inside
  `<gemini-dir>/antigravity-cli/conversations/<id>.db`.
- Sessions launch with `--dangerously-skip-permissions` and still select `auto` via
  `session/set_mode` when `modes.availableModes` lists it (Gemini Enterprise accounts are not
  offered it); otherwise they skip `session/set_mode` and log the agy version and mode IDs. Any
  remaining `session/request_permission` prompt is answered with `allow_once` while the Agent is
  live.
- Model and effort replay on every open, because a loaded session starts at agy's defaults. They
  apply by `category` (`model`, then `thought_level`) through `session/set_config_option`, skipped
  when already current, and the shared ACP rule decides failures. The `thought_level` choices follow the model just applied:
  Hydrogen adds `xhigh`, and Orchestrator and GPT-OSS have no `thought_level` select.
- Resume prefers `session/resume` when `initialize` advertises `sessionCapabilities.resume`
  (avoiding history replay on reconnect), falling back to `session/load` on `-32601`/`-32602`
  and using `session/load` directly otherwise; `-32002` means the stored session is gone and is
  replaced with a fresh one reported as `replaced`, and any other failure surfaces. agy 1.5.10
  answers success for an id it never stored and opens it empty; the adapter does not second-guess
  that.
- Interrupt is the shared `session/cancel`: the running prompt answers `cancelled` and the same
  process takes the next prompt. A session survives the process: a killed `agy acp` resumes
  through `session/resume` (or `session/load`) on a fresh process.
- Input during a live turn is a second `session/prompt` — the server's steer path, so delivery
  is `direct`. The steered prompt resolves `end_turn` with the merged turn's usage when the turn
  ends, and the first prompt resolves `end_turn` too — not `cancelled`. A steered turn is one
  merged turn: every prompt's updates join the one turn reader and `completed` fires once when
  the last prompt resolves, settled by the latest steered prompt's outcome (so a steered in-band
  warning, non-`end_turn` stop, or non-`-32602` RPC error fails the merged turn instead of
  completing silently). Only `cancelled`, `refusal`, a missing `stopReason`, or an invalid-params
  `-32602` steer error reports `notice-undelivered` so the daemon redelivers once idle.
  A steer whose answer never arrives holds the turn open until interrupt — there is no watchdog
  on the merged turn's length.
- Inputs exceeding 185,000 UTF-8 bytes (`ANTIGRAVITY_MAX_INPUT_BYTES`) are rejected before
  `session/prompt` dispatch (for both initial turns and busy-turn steers) so `agy` does not
  silently truncate long prompts; the error classifies as `input_too_large` and leaves the
  session healthy for subsequent inputs.
- A terminal RPC failure after prompt submission is an accepted failed turn, not an admission
  refusal. Both standalone in-band `⚠ Individual quota reached… Resets in …` warnings (with no
  `usage` and no tool/thought activity) and RPC prompt errors carrying that reset sentence emit a
  `window_limit` `providerLimit` with the computed `resetsAt` instant so the daemon waits for the
  reset instead of completing silently.
- A `tool_call`'s `title` is a description (`ls`, `File a.txt`); the tool name is agy's own
  `name` (`run_command`, `read_file`, `edit_file`), which `TOOL_ALIASES` maps. agy's
  `CommandLine` is also given as `command` and `Path` as `file_path`, the keys Activity and the
  reply-intent scanner read.
- `usage_update` (`used`/`size`) is reported as context usage after each model call.
- The model catalog is `session/new`'s `model` select (`acp-catalog.ts`), not `agy models`. The
  daemon runs the probe in a fresh temporary directory removed after the probe; the probe session
  switches through the models once to read each one's `thought_level` choices and current value
  (`acpReadModelEfforts`, shared with Droid), restores the initial model and `thought_level`, and
  then closes with `session/close`. Account usage reads `agy -p /usage --output-format json`, which
  answers without a turn (and is refused when `GEMINI_HOME` selects a non-default profile).
- Headless login (`agy acp --login`) runs with a temporary `0700` `PATH`/`BROWSER` shim
  (`xdg-open`, `open`, `browser-shim`) scoped only to that child process and removed on exit. URLs
  captured either from stdout or from the shim pass through the same `https://accounts.google.com`
  allowlist before being emitted to the user.
