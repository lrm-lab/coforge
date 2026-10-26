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
- `code-agent-inventory-sync.ts` owns inventory/catalog reports, liveness checks and
  refresh serialization. `runtime.ts` decides when to report; Agent traffic never waits. Each inventory also feeds `runtime-auth-reporter.ts`, which reports login status, never on a timer (every inventory report or re-discovery, login/logout via `refreshRuntimeAuth()`, `reauth` scans); unchanged provider lists still re-read auth because executable paths or environments may have changed. Successful usage scans do not refresh auth. Refused reports log a credential-redacted reason at info.
- `session-invalidate-activity.ts` narrates the cold-start Activity after a session invalidate. `runtime.ts` only publishes it.
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
  is the only local send state. It carries its send's `idempotencyKey`;
  `--send-draft` reuses it, and only that key's accepted send clears the draft.
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
