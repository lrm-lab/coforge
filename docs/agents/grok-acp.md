# Grok persistent ACP

The Grok provider requires **Grok Build 1.0.62 or newer**. A session owns one
`grok agent --no-leader stdio` process. It uses the existing process-tree owner,
including terminal cleanup's five-second graceful-exit allowance and forced-exit
fallback. This change does not install a CLI or restart a running Computer.

Idle input uses `session/prompt`. Its native queue admission acknowledges input;
the long-running prompt response does not delay acknowledgement. Busy input uses
`_x.ai/interject` and waits for its `result.status: queued` response. If turn end
races the interjection, Grok itself runs the notice as a fallback prompt. CoForge
must not independently resend that accepted notice.

Native `_x.ai/queue/changed` running IDs establish live turns, including autonomous
turns from background commands, monitors, and other native background work.
`_x.ai/session_notification` with `turn_completed` ends the matching prompt ID.
The prompt response can also settle its own turn, but never another, later turn.
A completed turn leaves the process alive. Background waiting remains enabled.

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
replay from live Activity. Model and reasoning selections are reapplied. Only the
existing, explicit remote-restore `404 Not Found` diagnostic allows replacement
with a fresh identity; a temporary restore or authentication failure preserves the
old identity and fails launch.

Folder trust remains limited to the Agent workspace (`--trust`), as in the
previous adapter. The provider keeps `--no-memory` and disables automatic CLI
updates; it does not turn off background tasks.

## Native verification

Run from `packages/daemon`, with an official Grok executable:

```sh
COFORGE_GROK_E2E_COMMAND=/path/to/grok mise exec -- bun test ./test/grok-native.e2e.ts
```

The tests isolate `GROK_HOME`, use a local model endpoint and placeholder test
credentials, and consume no provider credits. Reports live under
`.amp/e2e/grok-native/`: `report.json` covers standing instructions, tool mapping,
compaction and cancellation; `acp-lifecycle.json` covers live interjection, a real
background command's autonomous follow-up, and history after process restart.
Both tests fail if prerequisites or required observations are absent.

Protocol fixtures exercise the public `GrokProvider`/`AgentSession` seam, including
correlated completion, background liveness, cancellation, process failure and
restore failure. Earlier one-process-per-turn assertions and their fixture are
replaced along with that implementation.

Sources: [official ACP guide](https://docs.x.ai/build/cli/headless-scripting),
[sessions](https://docs.x.ai/build/features/sessions),
[background tasks](https://docs.x.ai/build/features/background-tasks), and
[official source](https://github.com/xai-org/grok-build) (reviewed at
`2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`; native verification on `1.0.62`).
The xAI extension names and rules-on-load restriction are implementation-specific,
verified against that source and the official binary rather than assumed ACP
standard features.
