# Daemon message attention and delivery

Rules for `packages/daemon/src/daemon-runtime/`, linked from its `AGENTS.md`.

- `agent-message-attention-index.ts` owns full-target thread attention, consumed
  cursors and pending settlement. Cursor fields are one private record per Agent/target;
  business operations coordinate updates and snapshot persistence inside this module.
  Callers use its message operations and queries, never a separate mutable state dependency.
- `memory-channel-updates.ts` coalesces ordinary Memory Agent channel deliveries per target: five updates or 30 seconds trigger a notice, whose body is read through `message_read`. Personal mentions remain immediate.
- A create or resume launch opens one startup turn. An `introductionPrompt` (first), real recovery
  input or an explicit `resumePrompt` takes precedence; a fresh session recovers existing memory/tasks,
  a resumed session uses its context before falling back to that recovery, and summary-only recovery reads each listed target once and acts only on
  work directed to the Agent. Never add a starter to a provider's already-running bootstrap turn.
- `agent-runtime/agent-startup.ts` owns startup input and the 120-second deadline (Stop, exit and
  shutdown cancel it); any event but bookkeeping, a bare `error` too, clears it. A launch fails at
  startup only on timeout, or when a startup or recovery input is rejected with `AgentSessionRecoveryError`
  or before an outcome, real work or `providerLimit` error answers it. Other errors are ordinary.
- After a successful current-generation `notify`, ordinary live Message delivery and concrete
  wake/resume batches report `Message received` Activity with detail kind `message_received`.
  Summary-only recovery and deduplicated inputs do not report it.
- `runtime.ts` publishes that best-effort Activity before the live delivery
  ACK. An observer failure must not reject accepted input.
- `agent-activity-publisher.ts` is the one place Activity gets its launch and sequence metadata,
  the stopping-launch mute, and the busy heartbeat; its last busy Activity is the daemon's mid-turn
  evidence (`busyAgents`, probes), a quiet turn's `Waiting for N background task(s)` included until
  its last task ends. A probe reply is never busy evidence. Reply intents ([reply-intent.md](../observability/reply-intent.md)) are no Activity: `reply-intent-publisher.ts` sends them.
- `runtime.ts` routes thread targets to the existing Agent session and
  canonicalizes short channel/DM thread targets. Threads never create sessions
  or processes.
- `coforge task read` is forwarded like other task routes, but the forwarder
  records its `consumptionScope` (`#board:#N`/`@peer:#N`, the delivery's own
  spelling) through `settleForwardedTaskRead`: the read's sequences count as
  seen, the scope binds to its conversation immediately so the cursor is
  durable, and it never records `review` — a task ref is not a thread context
  the send guard should learn.
- A delivery counts as consumed when its sequence is at or below its target's
  frontier, or is one of the target's exact seen sequences (`exactSeqs`:
  durable beside the frontier, at most 2500 per target, pruned as the
  frontier reaches them). A `check`, an anchored `read`, and a `read` the
  server does not call contiguous (`modelSeenUpToSeq: null`) record exact
  sequences only: no frontier, no read order. A `read` with a boundary moves
  the frontier there and reviews the target; one that found nothing only
  reviews it. The one inferred boundary is a held task result, which marks its
  newest inlined message model-seen. A send reports the exact sequences above its
  `seenUpToSeq` as `seenExactSeqs`; a sent response's `seenUpToSeq` (the server
  advanced over messages already seen) moves the frontier. A `search` never
  counts: it shows a truncated preview without whether the message mentions
  the Agent.
- A target's consumed cursor belongs to one conversation: a delivery binds the
  target to its `conversationId`, and a target seen under another conversation
  (a channel deleted and recreated under the same name, whose sequences restart
  at 1) starts over. Rows without a `conversationId` are dropped on read,
  since they cannot say whose sequences they hold.
- The attention index is the consumed cursor's source of truth once it has
  read the Agent's state database, and an operation that changed it writes one
  snapshot (one transaction). A read's
  state is kept under its `consumptionScope.target` (a channel's top level is
  already canonical); the spelling the Agent used becomes an alias of it. A
  consumption scope for this Agent settles, in every other target of that
  conversation (and thread, matched by root whatever its case), only the
  messages the read returned.
- An untracked delivery is ACKed as soon as the daemon takes custody of it:
  when its notice is accepted, or when it is held for a later notice or launch
  (`AgentDeliveryGate`, a failed launch's input queue). A delivery queued
  behind the runner hold of a `coforge-computer restart` is not ACKed.
- An Agent with no process and no launch in progress takes no custody
  (`agent-exited-delivery.ts`): its untracked delivery, and any a lifted
  runner hold left queued for it, is rejected as `no_process` over
  `agent:v1:message:reject` — the server decides whether to start it —
  unless a runtime error took it offline (`agent-offline-residency.ts`),
  which keeps custody even while a restart config still stands: ACKed,
  queued in `AgentDeliveryGate`, `inactive` and its Activity restated.
  A failed server Start leaves no restart config or failure record.
- A failure that takes an Agent offline also drops its restart config
  (`AgentProcessManager.forgetRestart` in `reportLaunchFailure`), so no
  delivery or App Inbox notice can wake it again — there is no
  auto-recovery: fixing the login does not restart the Agent by itself.
  Only a person's Start launches it; the new `active` session clears the
  record and the next launch delivers what waited. A quota wait keeps the
  restart config — its cooldown, not custody, governs the next launch.
- A tracked @mention delivery (it carries a `mentionDelivery` envelope) is
  settled by `mention-delivery-tracker.ts`, in memory only. It is ACKed, with
  its envelope echoed, only once drained: already consumed (whatever launch the
  envelope names), or told to the launch and native session the daemon last
  reported, at a moment the Agent is idle or in a turn that has ended. It
  never becomes `no_process`. An Agent with no process but a restart config and a remembered launch
  accepts it against that launch, keeps it unacknowledged and wakes the Agent as an untracked delivery
  would (`AgentExitedDelivery.deliverMention`); a launch that fails refuses it `DELIVERY_REJECTED` (a
  failed server Start, or a runtime error that takes the Agent offline, `IDENTITY_UNKNOWN`); while a
  launch-failure cooldown runs, one timer wakes the Agent when it ends (waiting out an extension, and dropped by a Stop, a purge or the daemon stopping) if anything still waits.
  Under a retryable runtime-error backoff (`rate_limit_backoff` or `runtime_error_backoff`) with the process
  gone it is kept the same way but wakes nobody, as the reference Computer holds a mention through a
  provider-limit wait: `RuntimeErrorDeliveryHold` tells `AgentExitedDelivery.backoffEnded` when the backoff
  runs its course (its time is up, a lifted limit or an observed recovery ends it), and that wakes the Agent
  once (after a launch-failure cooldown, if one runs); the launch tells each kept mention once. The backoff's
  end is its only bound. It is refused exactly once if the backoff never gets to end it: an inbox
  purge or a failed wake launch (`DELIVERY_REJECTED`), a failed server Start or a runtime
  error that takes the Agent offline (`IDENTITY_UNKNOWN`). A Stop and the daemon stopping report nothing
  for a tracked mention, as the reference Computer sends nothing: the tracker holds every report about the
  Agent's mentions while the Stop runs, and once the process is confirmed gone forgets what it had not
  drained (received, pending, kept, queued behind a notice) with those reports, so nothing is told later by
  mistake. A Stop that cannot confirm the process gone sends the held reports and settles each mention as a
  turn's end does. The cloud settles it: a person's Stop settles the Agent's pending mentions as not
  launched, and any other stop leaves them pending for the cloud to issue again, under the same delivery
  id, to the next launch, which tells each once. A tripped fingerprint fence, an offline record and
  a stopped Agent refuse it as `IDENTITY_UNKNOWN` at once: the reference Computer has no identity to hold it
  for either. Otherwise
  the daemon reports a terminal error: `IDENTITY_DRIFT` (another Computer,
  launch or session), `INSTRUMENT_FAILED` (another message), `IDENTITY_UNKNOWN`
  (no running session and nothing to relaunch from: stopped by a person, taken offline, held by a
  tripped fence, or never launched here, including a pending server Start),
  `QUOTA_LIMITED` (rate-limit backoff), `UNSUPPORTED_DELIVERY_PATH` (a provider
  that takes notices only between turns, while busy), or `DELIVERY_REJECTED`
  (another backoff, a refused notice, a process gone before it accepted the
  notice, an inbox purge). Told during a turn, it stays pending until the
  turn ends, then is drained if the current session was told it and
  rejected otherwise, every pending mention in one synchronous pass over the tracker's state (the
  reports follow unawaited, so none delays another's settlement); one named by `notice-undelivered` is settled instead by
  the redelivery of that notice (drained once accepted). A runner hold queues it
  unacknowledged; one still queued for an Agent without a session when the
  hold lifts is refused. Nothing is reported when a process exits. A restart of the process
  (`RuntimeRelease`) keeps the mentions it had not settled for the next launch (`mention-carry.ts`):
  after the process is gone, one still being told, or waiting, always; one already told during a turn
  only when the next launch starts a fresh session (a resumed session holds its notice; it settles at
  that session's turn end as usual). A mention arriving while the runtime ends or a launch is in flight is
  held against the launch and session last reported (another is `IDENTITY_DRIFT`; none is
  `IDENTITY_UNKNOWN`), and a repeat adopts its newer envelope and is reported coalesced. The next launch's
  input tells each carried mention once, in its own notice, without checking its envelope again, so it
  is ACKed with the latest envelope. A carried mention counts as work parked for the launch, so a cold idle or config-apply stop wakes the Agent for it, and a repeat of a mention told to a process that has since gone is carried the same way. A notice that settles for a process the restart replaced never refuses
  its mention (compared by process identity, not only while the restart is under way). A process that will not exit
  leaves everything as it was; an inbox purge rejects the carried and queued mentions of the purged
  conversations.
- While a server Start is pending for such an Agent
  (`AgentControl.startPending`: from the `start` call through every
  launch-retry cooldown), its untracked deliveries are held, unacknowledged, instead of
  rejected. When the Start settles, a launched Agent receives them as ordinary
  deliveries; otherwise they are dropped unacknowledged and stay unread in the
  cloud.
- An inbox purge (`agent:v1:inbox:purge`) drops the waiting deliveries and
  pending attention of channels the Agent can no longer read, threads
  included; an untracked delivery it drops is ACKed, so a later rejoin does not replay it on
  `ready` (a Start still surfaces it as unread from the read boundary).
- `runtime-error-delivery-hold.ts` owns an Agent's delivery hold after
  mid-turn runtime errors — backoff, fingerprint fence (a trip is taken
  offline by `agent-offline-residency.ts`), the release timer (`runtime.ts`
  only reports to it; `stop` disposes it). The backoff's end, reason and provider are
  also written to `agent-state/<agentId>/runtime-backoff.json`
  (`persistence/agent-runtime-backoff-store.ts`) and restored when the Daemon
  starts, so a usage limit outlives a restart; an expired record is dropped.
  A hold waiting out a retryable failure also keeps the stall sweep away
  (`stalled-recovery.ts`).
- Never launch an exited Agent for a delivery it has already consumed; ACK it
  instead.
- A failed message-triggered launch starts the per-Agent wake cooldown
  (`LaunchFailureBackoff`, no attempt cap); any successful launch ends it.
  Deliveries that wait for the next launch (in the cooldown, in a failed
  launch's input queue, a batched wake launch in flight, or kept by an offline
  Agent) wait in `AgentDeliveryGate`, already ACKed. The next launch presents
  them in one notice, or a server recovery notice covers those whose target it
  announces (`recover` returns those targets; a message it finds already read announces nothing); the rest are
  presented as for a launch without recovery. `flush` gives
  them `receive`'s treatment (consumed, malformed). An explicit Stop, or a
  launch abandoned because its recovery notice was rejected, discards them;
  the next Start recovers them from the cloud read boundary.
- `stalled-recovery.ts` owns when a message restarts a stalled provider instead
  of being steered into its turn; `runtime-release.ts` performs it, and the cold
  idle stop (`agent-runtime/AGENTS.md`). Count only raw provider events and
  turn-starting input as progress, never published Activity, and never let it
  touch `hasLiveTurn`. Do not restart over an open tool call or an unresumable
  session. `stalled-recovery-sweep.ts` applies the same judgment every five
  minutes to every live Agent with queued deliveries, so a stall whose last
  message already waits is recovered without another arrival; a runner hold, a
  mid-stop Agent or a recovery in flight suppresses the judgment. A tracked mention is kept for the relaunch (see the tracked @mention rules above).
- Thread follow state is cloud-persisted. The Daemon only forwards the Agent's
  explicit unfollow operation.
- What an Agent has already been shown lives in `AgentContextLedger` (`state.db`,
  `context_observations`), kept per context: a sender's description and a
  channel's role line (`channelCoordination`) reach the Agent once, and
  `AgentMessageOperations` leaves repeats out of `check` and the reads. A launch
  or a finished compaction starts a new context, and only runtimes whose
  adapter declares a finished compaction (`CodeAgentProvider.reportsCompaction`)
  are elided, so a runtime that cannot say when its context was cut is never
  left short. The embedded `coforge` runtime and `pi` share the Pi adapter.
  The context number is stored, never counted from zero again after a restart.
