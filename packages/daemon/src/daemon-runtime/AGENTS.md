# daemon-runtime instructions

Rules for one Workspace child's runtime in `src/daemon-runtime/`. They extend
`packages/daemon/AGENTS.md`.

## Boundary

- It coordinates the acknowledged cloud `agent:session` report for the current
  Workspace daemon and Agent launch, and keeps only volatile acknowledged
  identity and launch references for already-authorized wakes.
- A launch this runtime initiates itself follows the launch-identity rules in
  [`agent-runtime/AGENTS.md`](../agent-runtime/AGENTS.md).
- `runtime-auth-controller.ts` owns private, volatile login/logout operations through Anvil and the existing SDK reports; codes never enter persistence, logs, traces or Activity.
- `code-agent-inventory-sync.ts` reports inventory/catalog (including the post-report Devin effort republish); Agent traffic never waits. Each inventory also feeds `runtime-auth-reporter.ts`, which reports login status, never on a timer (every inventory report or re-discovery, login/logout via `refreshRuntimeAuth()`, every answered usage scan); unchanged provider lists still re-read auth because executable paths or environments may have changed. Scan replies wait for auth collection and reporting, regardless of usage support or result. Refused reports log a credential-redacted reason at info; a scan requiring a fresh snapshot answers error if reporting fails. Background inventory reports remain best-effort.
- `assemble-exited-delivery.ts` keeps a tracked @mention through a retryable runtime-error backoff without waking the Agent; `RuntimeErrorDeliveryHold` tells `backoffEnded` when the backoff runs its course, which wakes the Agent for it.
- `reset-credit-consume.ts` runs one reset credit attempt for `provider-scan-handlers.ts`; the idempotency key is checked where the request is routed (`daemon-provider-publications.ts`) and is never logged.
  - `unknown` is the answer to anything that leaves the credit possibly spent (an adapter failure, a Daemon on its way out); never turn it into a refusal or a retry here.
  - The usage sent back is read after the attempt. An earlier observation still counts the spent credit, so with no fresh read none is sent.
  - `reset` and `already_redeemed` lift the provider's limit (`liftProviderLimit`), and a failure lifting never loses the outcome's report.
- `provider-limit-lift.ts` ends every wait a provider's quota or rate limit caused, each through the owner that holds it, a rate-limit hold with no reset time included. A short launch backoff, a non-rate-limit hold and another provider's wait stay.
  - The owners are `RuntimeErrorDeliveryHold.releaseRateLimitBackoffs` (also the backoffs a restart restored; they carry their provider in `runtime-backoff.json`, and an old record without one keeps waiting), `AgentControl.endQuotaLaunchWaits` (a managed Start's quota retry runs now), `AgentOfflineResidency.endLaunchWaits` and `LaunchFailureBackoff.endRecoveryWaits` (the wake cooldown, matched through the Agent's restart config). A new owner of a quota wait records its provider with the wait and joins this list.
  - Ending a wait wakes nobody, except an Agent with no process that keeps tracked mentions through the backoff: its backoff's end wakes it once unless a launch is already coming. An Agent with a process gets its held deliveries flushed; one without keeps its queue for its next launch.
  - Only the Workspace child that took the request lifts, although the Codex account's limit is shared across the Computer. Reaching the other children needs a new `LOCAL_RPC_METHODS` entry in `packages/coforge-sdk/src/internal/local-daemon.ts` and a Coordinator fan-out like the runner hold's; the Coordinator and its children only exchange the existing fixed methods.
- `claude-model-quota-holds.ts` projects the Workspace's model quota ledger onto the
  active trusted account and model bindings. The input drain owns deferred inputs
  and releases them after the matching hold clears.
- `phase-bookkeeping.ts` holds each phase's open state and stale watchdog per Agent: providers report raw signals, it decides the wire Activity and closes a review silently at a turn's end.
- `launch-inbox.ts` is the per-Agent store of the daemon's undelivered input: the deliveries held behind `AgentDeliveryGate` (mode, busy, explicit hold, app items, fallback notices), the debt a cold start owes (`OwedRecovery`) and the input queue `AgentInputDrain` drains. It outlives launches and exists only while it holds something.
- `mention-carry.ts` keeps the tracked mentions a restart of the process leaves unsettled (and those arriving meanwhile, or kept through a runtime-error backoff) as entries the next launch tells once, in one notice with the deliveries held for it; `mention-delivery-entries.ts` is the tracker's memory of accepted mentions; `reported-sessions.ts` holds the launch and session each Agent last reported.
- `agent-input-drain.ts` owns each Agent's serialized input queue: enqueue is admission, one drain loop is the only consumer, and a closed queue settles its live drain. A new launch retires the queue (`startAgent`): the ended runtime's waiting deliveries go to `AgentDeliveryGate` custody (tracked mentions are kept as carried entries for the launch), its prompts carry over (an introduction always, a resume prompt only if the launch has none), and a retired loop's failures never touch the launch that replaced it. `agent-launch-custody.ts` owns what the daemon owes a launch at its boundary: delivery custody acknowledgment, the recovery pass that reconciles held state, and turn-open bookkeeping.
- `agent-stop-registry.ts` owns which Agents are stopping and which Session each launch reported: readers ask `isStopping`/`pendingStop`/`sessionReference`, and a write happens only where a stop begins or settles, where a launch reports its Session, or where a whole-runtime stop marks every Agent.
- `assemble-runtime-startup.ts` wires Workspace services and publication handlers into the startup ports owned by `runtime-startup.ts`.
- `computer-terminal-session.ts` owns the single shell, attach lease and input sequencing.
  `computer-terminal-output.ts` owns contiguous output and the bounded replay prefix.
  `computer-terminal-composition.ts` binds a verified Computer owner to the local PTY.
  `computer-terminal-relay.ts` bounds frames and routes them over the Workspace connection.
- `runtime-stop.ts` owns the closing flow — closing local capabilities, bringing Agent processes down, settling reminders/migrations/Pi chat, reporting the Agents inactive, revoking their keys, the shutdown notice and taking the transport down; `runtime.ts` owns the runner hold and the `stopping` flag it flips around it.
- `runtime-ready-wait.ts` reports publications held before ready past `READY_WAIT_LOG_TIMEOUT_MS` (2 minutes), repeating every `READY_WAIT_LOG_REPEAT_MS` (10 minutes) until released: `runtime:ready_wait_long` carries the accumulated wait, the ready attempts it outlasted and how many publications are held, so a stalled start is visible instead of looking like a healthy daemon ignoring every intent. The clock starts at the first `publications.install()` and a ready that fails and is retried keeps it, because an outage answers each attempt in seconds while the hold lasts hours; only a release, `close()` or `abort()` settles it. `runtime-startup.ts` counts an attempt from the ready request factory, which the connection calls once per attempt. Log only.
- `agent-stop-coordinator.ts` owns release/stop ordering once admission closes; a stop always completes ([agent-runtime](../agent-runtime/AGENTS.md)).
- `stalled-recovery-sweep.ts` restarts a busy turn silent past its fuse — 15
  minutes for a session that declares `steersBusyTurn`, 60 for one that only queues
  input — with no live open tool call (an open call whose OS descendants exited counts as
  `completion_loss`) and a resumable session even when no message waits, reaping 60-minute-silent
  zombie background tasks with zero live OS descendants before judging background work. Silence is awake time (`platform/awake-clock.ts`), so a machine's sleep never counts
  toward a fuse. Such an unattended restart resumes
  with a prompt naming where the turn stopped, and at most `UNATTENDED_RECOVERY_LIMIT` run in a row
  before a turn completes; past that the owner sees an error and only a message or a restart helps.
- `agent-config-apply.ts` (built by `agent-config-apply-assembly.ts`) applies an `AgentConfigSync` only
  when its Agent is next idle, never by cutting a turn, and always as a restart: env and credentials
  are read at launch. Details and log outcomes:
  [config apply](../../../../docs/observability/agent-status-and-activity/config-apply.md).
- `task-idle-nudge.ts` asks the cloud once when a turn leaves an Agent idle, and writes the
  answer as idle input: one ask per Agent at a time, 15 seconds, a 404 pauses asking for an hour
  (the web and the Computer ship separately), and `freshSession` is sent once per fresh session and
  re-armed once whenever `AgentContextLedger.generation()` advances on compaction.
- `turn-end-compaction.ts` triggers native provider compaction once per context generation at
  `Working -> Idle` when observed context usage exceeds `250_000` tokens (`COFORGE_IDLE_COMPACT`,
  `COFORGE_IDLE_COMPACT_MIN_TOKENS`) and the Agent is genuinely idle.
- `wake-loop-guard.ts` tracks consecutive wakes on the same message/delivery key that complete with
  zero tool calls and zero `coforge` message/task writes or holds: 60-second backoff at streak 2 and
  parked at streak 3, resetting when a new delivery key arrives or real work happens.
- `resumed-early-crash.ts` owns the stored-Session early-crash streak (Raft 1.0.63
  `noteResumedEarlyCrashClose`): a resume that exits silently inside 15 seconds counts, and the
  second consecutive close makes `runtime.ts` invalidate the Session (`repeated_early_crash`)
  and cold-start a fresh one through the ordinary launch gate.
- Read [provider replay recovery](../../../../docs/observability/agent-status-and-activity/provider-replay-recovery.md) when changing `provider-replay-recovery.ts` (rejected-replay watch, what the fresh Session carries, `OwedRecovery`).
  What it carries is owed (`OwedRecovery`, kept in the Agent's `LaunchInbox`) until a launch for the Agent
  has told it: `startAgent` merges it into the next launch that spawns a process and pays it after
  that launch's input is delivered. Only a Stop `AgentControl` accepted (`stopAccepted`; an unmanaged
  one in `handleAgentStop`), the Agent's delete and a whole-runtime stop drop it, never the stop
  that cleans up after a failed launch.
- `agent-wake-control.ts` owns reused-wake identity reads and control-record wake ordering; an
  unavailable provider identity keeps the wake and preserves the last known identity.
- `agent-rebind.ts` is `AgentControl.start()`'s one seam for rebinding an already-running process to a newer control scope: launch and session references are re-pointed in place and the Session and `agent:status` are re-reported; nothing is spawned or stopped.
- `agent-environment-activity.ts` names the Agent environment variables a launch had to skip (`code-agent/environment.ts`), so a stored value the rule refuses is reported rather than deleted.
- A start that fails stops its transport before replacing it, so a connection
  that came up never keeps reporting the Computer online for a Workspace that
  did not start. `stop` aborts a start still waiting on the cloud (connect or
  first ready).
- A deliberate `stop` sends the shutdown notice after its Agents are down,
  alongside (never ahead of) the Agent key revokes, and before the transport
  closes. Only a hold renewed within `SHUTDOWN_HOLD_REASON_WINDOW_MS` names
  the reason (`shutdown-reason.ts`); a stale or absent hold is
  `computer_stop`. Hold reasons are `RunnerHoldReason` values, never literals.
- The same `stop` also waits, within the same bound
  (`DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS`) and alongside the notice, for reminder
  work already running (a Due ACK, an App Inbox delivery, a record write) to
  settle, so no Due record write lands after `stop` resolves. When the bound passes it logs
  `daemon_runtime:reminder_settle_timed_out` at info and goes on.
- Context-usage change detection lives here: skip an unchanged reading and
  forget the last reading on launch end or dispose. `connection/` only sends.

## Personal memory review

- `agent-memory-composition.ts` assembles local API writes and review for the original Agent.
- `memory-idle-review.ts` owns low-priority personal review admission; the existing idle facts
  gate it behind messages, tool calls, background work, holds, migration and compaction.
- Human activity comes only from typed human DM/mention/Task deliveries with creation timestamps;
  replays cannot advance the watermark. System or Agent messages never qualify.
- Successful local API writes enqueue key/revision pairs. Review writes never rearm review;
  a newer human interaction restores ordinary write tracking. Only batch-matching receipts can
  clear keys, and only while their queued revision still matches.
- Checks use existing sessions only. Each admission consumes its human watermark and 24-hour
  cooldown before notifying, so an ambiguous delivery or restart cannot repeatedly invoke models.
- The two-minute prompt budget is advisory. No provider kill timer may interrupt a newly arrived
  human task. Review candidates remain local and no background pass reads private chat history.

## Message attention and delivery

Read the [message attention and delivery rules](../../../../docs/agents/daemon-message-attention.md) when changing that behavior.

## Credential-invalid hold

Behaviour: [credential-invalid hold](../../../../docs/observability/agent-status-and-activity/credential-invalid-hold.md).

- `credential-invalid-ledger.ts` records which credential is known invalid, keyed `shared:<runtime>` for a sign-in Agents share or `agent:<id>` for an Agent's own; `provider-credentials.ts` is the one table of which provider settings make a credential an Agent's own, which providers cache credentials in-process (`restartsOnCredentialChange`), and how their account digest is read.
- `credential-invalid-holds.ts` holds and releases the Agents on a record through the delivery gate's `credential_invalid` reason; who is held is read from the gate, never mirrored. Only a person's Stop, a delete or an operator stop releases through `agent-lifecycle.ts`; a launch the daemon tears down never does. Managed Starts invoke `credentialStarted` via `AgentControl.startAccepted` (only after fencing and replay checks pass). For `restartsOnCredentialChange` providers (Codex), sign-in, sign-out (`RuntimeAuthController.onSignedOut`), disk credential changes and `explicit_start` on a held live process recycle the idle process via `credential-recycle.ts` and `RuntimeRelease.stopForCredentialChange` rather than flushing into the stale process.
- `credential-disk-watch.ts` polls each watched credential (files by stat, then digest; on macOS the Keychain item's attributes, never its secret) and reports a change, and live-watches running `restartsOnCredentialChange` Agents (ignoring same-account refreshes, recycling on account change or file removal/reappearance); `assemble-credential-holds.ts` wires the holds, the watch, `credential-recycle.ts` and the `agent:credential:restored` report.

## Agent HTTPS forwarding

See [https-forwarding.md](./https-forwarding.md).

## Skills metadata

- Resolve the stable Agent directory and route Skills queries and results; never parse skill files here. That belongs to `code-agent/agent-skills.ts`.
