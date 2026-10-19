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
`error`) fails it with an error event. A process failure or a rejected prompt fails
the turn with its own error; a rejected prompt reports Grok's `data.detail`.
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

Fresh sessions append standing CoForge instructions through `session/new._meta.rules`.
The ACP launcher does not consume headless `--rules` as session instructions.
Native resume retains its saved system prompt and rules: Grok deliberately does
not append fresh `_meta.rules` during `session/load`. Updated standing instructions
therefore take effect in a new session. We do not replace Grok's full native system
prompt or turn instructions into a user message.

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
COFORGE_GROK_E2E_COMMAND=/path/to/grok mise exec -- bun test ./test/grok-native.e2e.ts
```

The tests isolate `GROK_HOME`, use a local model endpoint and placeholder test
credentials, and consume no provider credits. Reports live under
`.amp/e2e/grok-native/`: `report.json` covers standing instructions, tool mapping,
compaction and cancellation; `acp-lifecycle.json` covers live interjection, a real
background command's autonomous follow-up, and history after process restart;
`restore-missing.json` records that resuming a never-created session ID starts a
fresh session, reported with the requested ID as `replaced`, and that a turn on it
completes. Every test fails if prerequisites or required observations
are absent.

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
Alignment reference: the [reference Computer](reference-cli-research/README.md) 1.0.47
(darwin-arm64, release `38026b19-199f-4f13-b044-de5a8f9b5b50`, examined 2026-10-19).
The xAI extension names and rules-on-load restriction are implementation-specific,
verified against that source and the official binary rather than assumed ACP
standard features.
