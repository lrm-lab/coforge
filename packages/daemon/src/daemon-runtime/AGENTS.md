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
- `session-invalidate-activity.ts` narrates the cold-start Activity after a session invalidate; `runtime.ts` only publishes it. It also builds that message's wire shape.
- `activity-draft.ts` builds the Activity envelopes and the launch/stop frames (`starting`, `idle`, `stopped`, `interrupted`, quiet turn, `runtime_error`); `runtime.ts` supplies the workspace and publishes them.
- `phase-bookkeeping.ts` holds each phase's open state and stale watchdog per Agent: providers report raw signals, it decides the wire Activity and closes a review silently at a turn's end.
- `runtime-event-observation.ts` translates one coalesced provider event into cloud Activity, Session and usage updates; `runtime.ts` supplies the collaborators it reads by reference.
- `agent-input-drain.ts` owns each Agent's serialized input queue: enqueue is admission, one drain loop is the only consumer, and a closed queue settles its live drain. `agent-launch-custody.ts` owns what the daemon owes a launch at its boundary: delivery custody acknowledgment, the recovery pass that reconciles held state, and turn-open bookkeeping.
- `agent-inbox-coordinator.ts` owns per-Agent Message/App Inbox state, app-item notices, and fallback notice release; `runtime.ts` supplies lifecycle and process ports.
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
  requests the daemon only authorizes and forwards, keeping no state. A
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
- Apply the attention/model-visible preflight to Task `claim` and status
  `update` only; `amend` gets no local preflight. After the preflight, forward
  without storing Task state or interpreting claims, status transitions, or
  human approval. Reviewer-isolation holds expose counts only.

## Skills metadata

- Resolve the stable Agent directory and route Skills queries and results; never parse skill files here. That belongs to `code-agent/agent-skills.ts`.
