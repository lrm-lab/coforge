# Grok persistent ACP

The Grok provider requires **Grok Build 1.0.62 or newer**. A session owns one
`grok agent --no-leader stdio` process. It uses the existing process-tree owner,
including terminal cleanup's five-second graceful-exit allowance and forced-exit
fallback.

Idle input uses `session/prompt`. Its native admission acknowledges input: a
`_x.ai/queue/changed` entry or running ID for the prompt, or a streamed
`session/update` whose `_meta.promptId` is that prompt. The long-running prompt
response does not delay acknowledgement. Busy input uses `_x.ai/interject` and
waits for its `result.status: queued` response. If turn end races the interjection,
Grok itself runs the notice as a fallback prompt. CoForge must not independently
resend that accepted notice. Grok refuses an interjection only with a JSON-RPC
error (`invalid_params` for an unknown session or malformed params); a refusal, or
any result but `queued`, was not queued, so CoForge delivers that notice through
`session/prompt` instead. A closed transport or a timeout leaves the outcome
unknown: delivery rejects and the notice is not resent.

Native `_x.ai/queue/changed` running IDs establish live turns, including autonomous
turns from background commands, monitors, and other native background work.
`_x.ai/session_notification` with `turn_completed` ends the matching prompt ID,
including a turn that ends before the session is reported, so the queue snapshot
replayed once it is ready cannot revive it. The prompt response can also settle
its own turn, but never another, later turn. A queue snapshot never ends a turn:
Grok can broadcast an idle snapshot before `turn_completed`, and only that
notification carries the turn's stop reason.
A completed turn leaves the process alive. Background waiting remains enabled.

Stop reasons `end_turn`, `max_tokens`, `max_turn_requests` and `refusal` complete a
turn without an error; `cancelled` interrupts it; any other reason (Grok reports
`error`) fails it with an error event. Grok sends a failed turn's error text as
`turn_completed.agent_result` (a string) before it rejects the prompt, so that text
is the error message; without it the message names the stop reason. A process
failure or a prompt rejected before its turn ends fails the turn with its own error;
a rejected prompt reports Grok's `data.detail`.
A `tool_call_update` ending `cancelled` ends the call as an error, with any
`content` text as its output.

The process runs with `--always-approve`, and `session/new` and `session/load`
also send `_meta.yoloMode: true`. Should Grok still send `session/request_permission`,
CoForge selects `allow_once` (else `allow_always`) for its own live session and
answers `cancelled` for another session, during an interrupt, or after disposal.

Queued and pending notice admission is cancelled before terminal disposal, and
cancelled input rejects rather than receiving a successful delivery acknowledgement.
An admission timeout closes the ambiguous native session before rejecting delivery,
preventing late native acceptance from racing a retry.
`interrupt` uses ACP `session/cancel` and waits for the affected native turns to
settle; terminal disposal begins process cleanup immediately.

## Instructions and recovery

The standing CoForge instructions replace Grok's system prompt verbatim: both
`session/new` and `session/load` send them as `_meta.systemPromptOverride`. A fresh
session starts with them; a load swaps the saved system head for them, both for a
session still resident in the process (per the reviewed source) and for a cold load
from disk (also verified natively on 1.0.62), so updated instructions take effect
when a session resumes. Grok ignores a blank override, and
CoForge then sends none, leaving the native or saved prompt in place. `_meta.rules`
is not used: Grok appends it to its native prompt on `session/new` only.
Known trade-off: Grok's native system text is not included. On 1.0.62 that is its
identity and its `dangerous_actions`, `work_policy`, `background_tasks`,
`scratch_files`, `communication`, `formatting`, `user_guide` and
`browser_verification` guidance. Tool definitions are still advertised, and project
`AGENTS.md` and the skills list still arrive as context messages outside the system
prompt (observed on 1.0.62).

`session/load` resumes the saved ID without forking and suppresses historical
replay from live Activity. Model and reasoning selections are reapplied. Resuming
requires `initialize` to advertise `agentCapabilities.loadSession: true`; without
it launch fails before `session/load`.

A `session/load` that fails with JSON-RPC `-32603` and `data.code: "FS_NOT_FOUND"`
starts a fresh session, reported as `onSessionId(new, replaced)`. Grok 1.0.62 maps a
local miss to that code whether its remote pull answers 404, fails, or is not
configured (`load_light` → `pull_on_miss` → `io_error_to_acp` in the reviewed
source); other I/O failures carry `FS_PERMISSION_DENIED`, `FS_DISK_QUOTA_EXCEEDED`
or `FS_OTHER`. Any failure other than `FS_NOT_FOUND`, including authentication,
preserves the old identity and fails launch. Known risk: a session stored only
remotely, loaded while the backend is unreachable, is indistinguishable from a
missing one, so that case also starts a fresh session.

Folder trust is limited to the Agent workspace (`--trust`). The provider keeps
`--no-memory` and disables automatic CLI updates; it does not turn off background
tasks.

## Native verification

Run from `packages/daemon`, with an official Grok executable:

```sh
COFORGE_GROK_E2E_COMMAND=/path/to/grok mise run test:file -- ./test/grok-native.e2e.ts
```

The tests isolate `GROK_HOME`, use a local model endpoint and placeholder test
credentials, and consume no provider credits. Reports live under
`.amp/e2e/grok-native/`: `report.json` covers standing instructions, tool mapping,
compaction and cancellation; `acp-lifecycle.json` covers live interjection, a real
background command's autonomous follow-up, and history after process restart;
`restore-missing.json` records that resuming a never-created session ID starts a
fresh session, reported with the requested ID as `replaced`, and that a turn on it
completes; `system-prompt-override.json` records that a fresh session's model request
carries exactly the instructions as its system message, and that a restarted process
resuming the session with changed instructions sends the new ones. Every test fails
if prerequisites or required observations are absent.

Protocol fixtures exercise the public `GrokProvider`/`AgentSession` seam, including
correlated completion, background liveness, pre-ready completion, streamed
admission, interjection refusal and lost answers, permission answers, stop
reasons, cancellation, process failure, restore failure and the `loadSession`
requirement.

Sources: [official ACP guide](https://docs.x.ai/build/cli/headless-scripting),
[sessions](https://docs.x.ai/build/features/sessions),
[background tasks](https://docs.x.ai/build/features/background-tasks), and
[official source](https://github.com/xai-org/grok-build) (reviewed at
`2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`, including `extensions/interject.rs` and
the `yoloMode` table in `xai-grok-pager/docs/user-guide/15-agent-mode.md`; native
verification on `1.0.62`).
Alignment reference: the [reference Computer](reference-cli-research/README.md) 1.0.50
(artifact target darwin-arm64, release `cd67c4a2-20c5-41f4-a59c-f089887d01f7`, examined
2026-10-19 with `scripts/reference-computer/extract.ts`; SEA asset `computer.cjs`).
Its Grok driver's protocol behaviour is unchanged from 1.0.47 (release
`38026b19-199f-4f13-b044-de5a8f9b5b50`, binary sha256
`34bb347a1f4c58b1bb6a2851f78079a4e7a742b7e832430478619ae8e59604e9`), where the
alignment was first made. "Core" below is the module labelled
`packages/daemon/src/drivers/grok.ts` and `grokEventNormalizer.ts` in `computer.cjs`
(`packages/daemon/dist/core-D2FAeq9h.js` in 1.0.47). Behaviours aligned with it:

- Missing-session replacement: a `session/load` error whose `data.code` is
  `FS_NOT_FOUND` starts a fresh session. The reference's `isMissingSessionError` also
  accepts "session not found" or "no such file" message text; CoForge deliberately
  replaces only on the structured code Grok 1.0.62 sends, so a transient failure
  never discards history.
- Approval: launch with `--always-approve` plus `yoloMode: true` session metadata,
  and answer a permission request with its allow-once option (core `GrokDriver`
  launch arguments, session metadata and auto-approval).
- Refused interjection: the reference reports it as a delivery failure and restores
  the notice for later delivery (core `GrokDriver`, then the process manager's
  async-rejection restore); CoForge sends it through `session/prompt` directly.
- Cancelled tool call: `cancelled` is a terminal tool status that ends the call
  (core `GrokEventNormalizer`).
- Stop reasons: `error` fails the turn with `agent_result` as its message (core
  `GrokEventNormalizer` prompt finish).
- Turn end: the `turn_completed` session notification finishes its prompt's turn
  (core `GrokEventNormalizer`).
- Instructions: the standing prompt is `systemPromptOverride`, sent with `yoloMode`
  on both new and load (core `GrokDriver`).

The xAI extension names and the override's handling on new and load
(`system_prompt` module, `enqueue_replace_system_prompt_override` and the
`session_setup.rs` load path in `agent/mvp_agent/`) are implementation-specific,
verified against that source and the official binary rather than assumed ACP
standard features.
