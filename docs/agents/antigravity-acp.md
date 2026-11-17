# Antigravity ACP behavior

Part of [the documentation index](../../README.md). The Antigravity adapter runs one persistent `agy acp` process per Agent session.

- The runtime is `agy acp`, the ACP server inside the `agy` CLI — one persistent ACP process
  per Agent session. It shares agy's own sign-in: no separate credential store, and the SSH
  session-marker rules below apply to every `agy` process the Daemon starts.
- The floor is agy 1.5.8 (`acp-version.ts`), from agy's changelog: `session/cancel` ends a prompt
  without stopping the next one from 1.5.1, the `auto` mode arrives in 1.5.4, and `usage_update`
  context readings in 1.5.8. Behavior below was verified live on 1.5.10.
- Standing instructions ride the `session/new`/`session/load` envelope as
  `_meta.antigravity.systemPrompt.append`, appended to agy's own system prompt; agy still reads
  the Agent workspace's `AGENTS.md`/`GEMINI.md`. A `session/load` applies the append it carries,
  so a resumed session picks up changed instructions. `disabledTools` in the same envelope is the
  optional host tool filter.
- Every open selects the `auto` mode when `modes.availableModes` lists it (Gemini Enterprise
  accounts are not offered it); otherwise it skips `session/set_mode` and logs the agy version and
  the mode IDs. `auto` still asks before commands that leave agy's terminal sandbox; the shared
  permission handler answers `allow_once` while the Agent is live.
- Model and effort replay on every open, because a loaded session starts at agy's defaults. They
  apply by `category` (`model`, then `thought_level`) through `session/set_config_option`, skipped
  when already current, and the shared ACP rule decides failures. The `thought_level` choices follow the model just applied:
  Hydrogen adds `xhigh`, and Orchestrator and GPT-OSS have no `thought_level` select.
- Resume is `session/load`; `-32002` means the stored session is gone and is replaced with a
  fresh one reported as `replaced`, and any other load failure surfaces. agy 1.5.10 answers
  success for an id it never stored and opens it empty; the adapter does not second-guess that.
- Interrupt is the shared `session/cancel`: the running prompt answers `cancelled` and the same
  process takes the next prompt. A session survives the process: a killed `agy acp` resumes
  through `session/load` on a fresh process.
- Input during a live turn is a second `session/prompt` — the server's steer path, so delivery
  is `direct`. The steered prompt resolves `end_turn` with the merged turn's usage when the turn
  ends, and the first prompt resolves `end_turn` too — not `cancelled`. A steered turn is one
  merged turn: every prompt's updates join the one turn reader and `completed` fires once when
  the last prompt resolves. A steer answer with any other `stopReason` (`max_tokens`,
  `max_turn_requests`) still means the text reached the model; only `cancelled`/`refusal` (or a
  missing `stopReason`) reports `notice-undelivered`, which lets the daemon redeliver once idle.
  A steer whose answer never arrives holds the turn open until interrupt — there is no watchdog
  on the merged turn's length.
- A terminal RPC failure after prompt submission is an accepted failed turn, not an admission
  refusal.
- A `tool_call`'s `title` is a description (`ls`, `File a.txt`); the tool name is agy's own
  `name` (`run_command`, `read_file`, `edit_file`), which `TOOL_ALIASES` maps. agy's
  `CommandLine` is also given as `command` and `Path` as `file_path`, the keys Activity and the
  reply-intent scanner read.
- `usage_update` (`used`/`size`) is reported as context usage after each model call.
- The model catalog is `session/new`'s `model` select (`acp-catalog.ts`), not `agy models`. The
  probe session switches through the models once to read each one's `thought_level` choices and
  current value (`acpReadModelEfforts`, shared with Droid), then closes with `session/close`. Account usage reads
  `agy -p /usage --output-format json`, which answers without a turn.
