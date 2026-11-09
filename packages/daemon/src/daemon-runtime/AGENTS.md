# daemon-runtime instructions

Rules for one Workspace child's runtime in `src/daemon-runtime/`. They extend
`packages/daemon/AGENTS.md`.

## Boundary

- `workspace-query-handlers.ts` binds scoped Skills/file/delete requests to the current runtime and transport.
- `agent-workspace-queries.ts` owns Skills/file observations; `ready-capabilities.ts` declares feature support.
- This directory owns one Workspace child's cloud-facing use cases and Agent
  runtime operations. The machine Coordinator is in `supervisor/`; transport
  mechanics are in `connection/`.
- It coordinates the acknowledged cloud `agent:session` report for the current
  Workspace daemon and Agent launch, and keeps only volatile acknowledged
  identity and launch references for already-authorized wakes.
- A launch this runtime initiates itself follows the launch-identity rules in
  [`agent-runtime/AGENTS.md`](../agent-runtime/AGENTS.md).
- `runtime-auth-subscription.ts` binds the complete private authentication transport seam.
- `agent-message-ports.ts` holds the Agent message operation dependencies.
- `runtime-auth-controller.ts` owns private, volatile login/logout operations through Anvil and the existing SDK reports; codes never enter persistence, logs, traces or Activity.
- `code-agent-inventory-sync.ts` owns inventory/catalog reports (including the post-report Devin
  effort republish), liveness checks and
  refresh serialization. `runtime.ts` decides when to report; Agent traffic never waits. Each inventory also feeds `runtime-auth-reporter.ts`, which reports login status, never on a timer (every inventory report or re-discovery, login/logout via `refreshRuntimeAuth()`, every answered usage scan); unchanged provider lists still re-read auth because executable paths or environments may have changed. Scan replies wait for auth collection and reporting, regardless of usage support or result. Refused reports log a credential-redacted reason at info; a scan requiring a fresh snapshot answers error if reporting fails. Background inventory reports remain best-effort.
- `assemble-exited-delivery.ts` builds the `AgentExitedDelivery` settlement for a delivery to an Agent with no hold, session or launch; `runtime.ts` supplies the collaborators it reads, those built after it as thunks.
- `reset-credit-consume.ts` runs one reset credit attempt for `provider-scan-handlers.ts`; the idempotency key is checked where the request is routed (`daemon-provider-publications.ts`) and is never logged.
  - `unknown` is the answer to anything that leaves the credit possibly spent (an adapter failure, a Daemon on its way out); never turn it into a refusal or a retry here.
  - The usage sent back is read after the attempt. An earlier observation still counts the spent credit, so with no fresh read none is sent.
  - `reset` and `already_redeemed` lift the provider's limit (`liftProviderLimit`), and a failure lifting never loses the outcome's report.
- `provider-limit-lift.ts` ends every wait a provider's quota or rate limit caused, each through the owner that holds it, a rate-limit hold with no reset time included. A short launch backoff, a non-rate-limit hold and another provider's wait stay.
  - The owners are `RuntimeErrorDeliveryHold.releaseRateLimitBackoffs` (also the backoffs a restart restored; they carry their provider in `runtime-backoff.json`, and an old record without one keeps waiting), `AgentControl.endQuotaLaunchWaits` (a managed Start's quota retry runs now), `AgentOfflineResidency.endLaunchWaits` and `LaunchFailureBackoff.endRecoveryWaits` (the wake cooldown, matched through the Agent's restart config). A new owner of a quota wait records its provider with the wait and joins this list.
  - Ending a wait wakes nobody. An Agent with a process gets its held deliveries flushed; one without keeps its queue for its next launch and only its waiting ends.
  - Only the Workspace child that took the request lifts, although the Codex account's limit is shared across the Computer. Reaching the other children needs a new `LOCAL_RPC_METHODS` entry in `packages/coforge-sdk/src/internal/local-daemon.ts` and a Coordinator fan-out like the runner hold's; the Coordinator and its children only exchange the existing fixed methods.
- `session-invalidate-activity.ts` narrates the cold-start Activity after a session invalidate; `runtime.ts` only publishes it. It also builds that message's wire shape.
- `activity-draft.ts` builds the Activity envelopes and the launch/stop frames (`starting`, `idle`, `stopped`, `interrupted`, quiet turn, `runtime_error`); `runtime.ts` supplies the workspace and publishes them.
- `phase-bookkeeping.ts` holds each phase's open state and stale watchdog per Agent: providers report raw signals, it decides the wire Activity and closes a review silently at a turn's end.
- `runtime-event-observation.ts` translates one coalesced provider event into cloud Activity, Session and usage updates; `runtime.ts` supplies the collaborators it reads by reference.
- `runtime-event-observation-ports.ts` declares the collaborators `runtime-event-observation.ts` reads (`RuntimeEventObservationPorts`) and the `Publish` signature it publishes through.
- `runtime-release-plans.ts` builds the `RuntimeReleasePlan` that `runtime-release.ts` carries out: what a stalled-runtime, feature-change or cold-idle release announces, logs and wakes.
- `runtime-lifecycle.ts` declares the restart, upgrade and refusal hooks the Computer lends one `DaemonRuntime` (`DaemonRuntimeLifecycle`); `runtime-connection-config.ts` declares the Workspace connection identity (`DaemonConfig`) it is constructed with.
- `agent-input-drain.ts` owns each Agent's serialized input queue: enqueue is admission, one drain loop is the only consumer, and a closed queue settles its live drain. `agent-launch-custody.ts` owns what the daemon owes a launch at its boundary: delivery custody acknowledgment, the recovery pass that reconciles held state, and turn-open bookkeeping.
- `agent-inbox-coordinator.ts` owns per-Agent Message/App Inbox state, app-item notices, and fallback notice release; `runtime.ts` supplies lifecycle and process ports.
- `runtime-reconnect.ts` owns reconnect recovery subscriptions; `runtime.ts` supplies inventory, reminder, replay, and upgrade-report callbacks.
- `agent-stop-registry.ts` owns which Agents are stopping and which Session each launch reported: readers ask `isStopping`/`pendingStop`/`sessionReference`, and a write happens only where a stop begins or settles, where a launch reports its Session, or where a whole-runtime stop marks every Agent.
- `agent-operations.ts` owns the cloud-facing Agent operations one runtime answers — the activity probe, the inbox purge for channels an Agent can no longer read, one Agent's stop, and the Agent's own message operation; `runtime.ts` supplies the collaborators they call.
- `runtime-services-composition.ts` builds the Workspace's background services — the reminder schedule, the System Cleaner and the App config sync it serves, and the migration runner when the transport offers that route — from one ports object; `runtime.ts` supplies the collaborators their ports call.
- `message-composition.ts` builds the Agent message state — tracked @mention deliveries, per-Agent attention, App Inbox coordination and the Agent's own message operations — from one ports object; `runtime.ts` supplies the collaborators those ports call.
- `agent-control-composition.ts` builds the Agent control records, the `agent:session` report each accepted snapshot produces, and the control ports through which Agents launch, stop, wake and rebind; `runtime.ts` supplies the collaborators those ports call.
- `runtime-stop.ts` owns the closing flow — closing local capabilities, bringing Agent processes down, settling reminders/migrations/Pi chat, reporting the Agents inactive, revoking their keys, the shutdown notice and taking the transport down; `runtime.ts` owns the runner hold and the `stopping` flag it flips around it.
- `runtime-startup.ts` owns one connection's open sequence — publication and auxiliary listeners, transport start, control/session replay, the ready handshake and the post-ready kickoffs — and the start promise, abort signal, subscriptions, Pi chat relay and runtime auth controller it installs; `runtime.ts` only decides when to open a connection.
- `runtime-publication-subscriptions.ts` owns pre-ready publication buffering and Agent/control/App/migration event listeners; `runtime.ts` supplies operation handlers and releases buffered work after ready.
- `runtime-ready-wait.ts` reports publications held before ready past `READY_WAIT_LOG_TIMEOUT_MS` (2 minutes), repeating every `READY_WAIT_LOG_REPEAT_MS` (10 minutes) until released: `runtime:ready_wait_long` carries the accumulated wait, the ready attempts it outlasted and how many publications are held, so a stalled start is visible instead of looking like a healthy daemon ignoring every intent (task #630). The clock starts at the first `publications.install()` and a ready that fails and is retried keeps it, because an outage answers each attempt in seconds while the hold lasts hours; only a release, `close()` or `abort()` settles it. `runtime-startup.ts` counts an attempt from the ready request factory, which the connection calls once per attempt. Log only.
- `local-session-query-handlers.ts` binds owner-authorized local Session list/search/excerpt requests to the bounded catalog and current transport.
- `agent-stop-coordinator.ts` owns process release/stop ordering after runtime admission closes; `runtime.ts` supplies launch maps and lifecycle collaborators.
- `stalled-recovery-sweep.ts` restarts a busy turn silent past its fuse — 15
  minutes for a session that declares `steersBusyTurn`, 60 for one that only queues
  input — with no open tool call and
  a resumable session even when no message waits (task #404), but never while a background task
  runs. Such an unattended restart resumes
  with a prompt naming where the turn stopped, and at most `UNATTENDED_RECOVERY_LIMIT` run in a row
  before a turn completes; past that the owner sees an error and only a message or a restart helps.
- `agent-config-apply.ts` (built by `agent-config-apply-assembly.ts`) applies an `AgentConfigSync` only
  when its Agent is next idle, never by cutting a turn, and always as a restart: env and credentials
  are read at launch. A Memory Agent is never stopped by it. Details and log outcomes:
  [config apply](../../../../docs/observability/agent-status-and-activity/config-apply.md).
- `task-idle-nudge.ts` asks the cloud once when a turn leaves an Agent idle, and writes the
  answer as idle input: one ask per Agent at a time, 15 seconds, a 404 pauses asking for an hour
  (the web and the Computer ship separately), and a fresh session is asked once per session
  (task #476).
- `agent-launch-coordinator.ts` owns launch identity and launch-state initialization; `runtime.ts` supplies lifecycle ports and start admission.
- `agent-launch-process.ts` owns the provider process boundary and its Session, Activity, and exit cleanup callbacks for one resolved launch.
- `resumed-early-crash.ts` owns the stored-Session early-crash streak (Raft 1.0.63
  `noteResumedEarlyCrashClose`): a resume that exits silently inside 15 seconds counts, and the
  second consecutive close makes `runtime.ts` invalidate the Session (`repeated_early_crash`)
  and cold-start a fresh one through the ordinary launch gate.
- `agent-launch-config.ts` owns the transport fallback for obtaining an Agent launch credential/config.
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
  work already running (a fire request, a wake, a receipt write) to settle, so
  no receipt write lands after `stop` resolves. When the bound passes it logs
  `daemon_runtime:reminder_settle_timed_out` at info and goes on.
- Context-usage change detection lives here: skip an unchanged reading and
  forget the last reading on launch end or dispose. `connection/` only sends.

## Message attention and delivery

Read the [message attention and delivery rules](../../../../docs/agents/daemon-message-attention.md) when changing that behavior.

## Agent HTTPS forwarding

- `agent-message-operations.ts` owns the Agent's `coforge message` operations
  (check, send, the forwarded rest, and Memory's pending-thread read guard). `runtime.ts` only validates the
  request and resolves its canonical target.
- `agent-request-forwarder.ts` (`DaemonRuntime.agentRequests`) holds the
  requests the daemon only authorizes and forwards. A forwarded task read's
  `consumptionScope` settles into the attention index (`recordForwardedRead`);
  everything else keeps no state. A
  request that reads or changes runtime state (Tasks, reminders, the App
  Inbox) stays in `runtime.ts`. Each one refuses a stopped daemon, an unknown
  context, or a malformed Agent API key through `authorizedAgent` first, so
  the Agent gets that `AgentPreflightError` code, never an unclassified 502.
- Message sends: the per-target draft (`persistence/agent-message-draft-store.ts`)
  and the held send's continuation (`persistence/agent-continuation-store.ts`) are
  the only local send state. The draft carries its send's `idempotencyKey`;
  `--send-draft` and continuation choices `a`/`d` reuse it, and only that key's
  accepted send clears the draft. A continuation records the offered choices one
  held send presented (`a`/`b`/`c`, plus `d` only when `continueAnywaySuggested`),
  is answered atomically once, and shares the draft's ten-minute lifetime.
  Never authorize `--anyway` locally.
- `agent-send-settlement.ts` settles one send: an ambiguous failure
  (pre-response or 5xx) gets one `reconcileAgentSend` and at most one same-key
  replay, never a blind retry. It sees the transport and the draft only through
  its ports; keep reconcile logic out of its callers.
- `agent-send-verdict.ts` is the one shape for what the daemon judged about a
  failed request (`retryable`, `draftSaved`, `suggestedNextAction`).
  `agent-proxy-failure.ts` classifies the cause, then applies the verdict. A
  failed replay is retryable only while the draft still holds its key. A
  `MESSAGE_REQUEST_IN_PROGRESS` refusal is judged too: delivery unknown,
  retryable under the draft's key with `--expected-draft-key` while the draft
  still holds it. In both, once another send replaced the draft, or the draft
  cannot be read, the verdict is not retryable and names no resend command.
- Agent Task operations use the Credential Proxy and the authenticated Agent
  HTTPS connection. Task parsing and wire contracts belong to the SDK and CLI;
  claim/review applies to complex, coordinated, or already-shared Tasks, not
  ordinary requests, and that standing guidance lives once in
  `code-agent/agent-instructions.ts`.
- Apply the attention/model-visible preflight to Task `create`, `claim` and
  `assign` (`task-write-freshness.ts`); `unclaim`, `update` and `amend` go
  through and let the server attach what the Agent had not seen. Every gated
  write forwards the model-visible boundary (`seenUpToSeq`, `seenExactSeqs`)
  so the route re-decides authoritatively, and the consumed frontier moves
  over shown context only after the write answered. After the preflight,
  forward without storing Task state or interpreting claims, status
  transitions, or human approval. Reviewer-isolation holds expose counts only.

## Skills metadata

- Resolve the stable Agent directory and route Skills queries and results; never parse skill files here. That belongs to `code-agent/agent-skills.ts`.
