# Agent HTTPS forwarding

Moved out of [`AGENTS.md`](AGENTS.md) to keep it under the size limit; the rules are unchanged.

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
