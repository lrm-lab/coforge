# Tracked @mention delivery

Rules for `MentionDeliveryTracker` and its collaborators in `packages/daemon/src/daemon-runtime/`,
linked from [message attention and delivery](daemon-message-attention.md). Each rule follows the
reference Computer's legacy host, the default one; where the two differ, this document says so.

A tracked delivery carries a `mentionDelivery` envelope. The tracker settles it in memory only: it
is ACKed, with its envelope echoed, only once drained, and a terminal error explains every other end.
It never becomes `no_process`.

## What drains it

- Drained: the Agent consumed the message (its consumed cursor covers the sequence), or the Agent's
  idle session was told it, or the session was told it during a turn that has since ended.
- Told during a turn, it stays pending until that turn ends, or until the model has seen the message:
  every write of the consumed cursor (`check`, `read`, a send's context) drains the Agent's pending
  and kept mentions it now covers, without waiting for the turn.
- A turn's end drains each pending mention the current session was told, rejects any other
  (`DELIVERY_REJECTED`) and leaves one named by `notice-undelivered` to that notice's redelivery. All
  verdicts apply in one synchronous pass; the reports follow unawaited. A compaction open at the
  turn's end changes nothing: the reference Computer holds the settlement only for a compaction its Pi
  driver reports as started after the run ended, and no adapter of ours reports that (`agent_settled`
  follows the compaction).

## Order of checks on arrival

1. Admission: another Computer is `IDENTITY_DRIFT`, another message `INSTRUMENT_FAILED`.
2. A runner hold queues it unacknowledged. A server Start in flight buffers it unacknowledged and
   replays it through this same path once the Start launched (`AgentExitedDelivery.holdMentionForStart`);
   a Start that does not launch drops it without a report.
3. Identity, before anything else about the delivery: the envelope must name the launch and session
   the daemon last reported, running or remembered for an Agent it can still relaunch. None is
   `IDENTITY_UNKNOWN` (stopped by a person, offline, held by a tripped fence, never launched here),
   another is `IDENTITY_DRIFT`. A consumed mention is no exception: it is refused, not ACKed.
4. A repeat of a drained mention is ACKed again. A repeat of one pending or still being told is
   reported coalesced and the entry keeps the newest envelope, whatever launch it names; the ACK echoes
   it.
5. A consumed mention is drained without telling anyone.
6. Otherwise it is told. A process mid-turn is told whatever backoff holds it (the mention is pending
   until the turn ends); only an idle one answers `QUOTA_LIMITED` (rate-limit backoff) or
   `DELIVERY_REJECTED` (another backoff, the fence), and a runtime that takes notices between turns
   alone answers `UNSUPPORTED_DELIVERY_PATH` while busy. A refused notice, or a process gone before it
   accepted the notice, is `DELIVERY_REJECTED` (`IDENTITY_UNKNOWN` when the session was lost mid-notice,
   which the server answers by waking the Agent).

## An Agent with no process

- With a restart config and a remembered launch it is kept against that launch and wakes the Agent
  as an untracked delivery would (`AgentExitedDelivery.deliverMention`). Under a retryable
  runtime-error backoff it is kept the same way but wakes nobody; `backoffEnded` wakes the Agent once.
- A wake launch that fails refuses only the mention whose arrival started it
  (`DELIVERY_REJECTED`). The others stay kept for the next launch: the failed launch's input queue
  hands the mentions it had taken back to the kept ones (`keepAfterFailedLaunch`), and the wake
  cooldown arms one wake for its end (`LaunchFailureBackoff.onFailure`, any failed wake). A launch
  that failed with nothing left to relaunch from (no restart config) refuses what is kept as
  `IDENTITY_UNKNOWN`, as does a failed server Start or a runtime error that takes the Agent offline.
- Those wakes end. The reference Computer stops relaunching an Agent locally after five failed starts
  in a row, or at once for a configuration failure (login, install, model setup), and leaves what it
  buffered to the server. Here the fifth failed wake (`WAKE_FAILURE_STREAK_CAP`; a wait on a named
  quota reset is not counted), a failure `isNonRetryableLaunchFailure` names, or a streak that
  outlives the wake deadline (twice the provider's startup window plus a minute) forgets the Agent's
  restart config and cooldown and refuses what is still kept (`giveUpWake`), after the trigger's own
  `DELIVERY_REJECTED`. The code says which cause ended it: a spent deadline is
  `STARTUP_DEADLINE_EXCEEDED` — a failure no single attempt named, reported on the same log line as
  its typed reason — and every other cause stays `IDENTITY_UNKNOWN`. The next delivery is rejected
  `no_process`, so the server decides whether to start the Agent, and a `STARTUP_DEADLINE_EXCEEDED`
  mention settles lost as not launched for good: its code is non-empty, so the daemon's own later ACK
  cannot re-settle it. The reference Computer reports no
  outcome for its dropped buffer; ours settles every kept mention exactly once.
- Refused exactly once, in addition: an inbox purge (`DELIVERY_REJECTED`).
- A Stop and the daemon stopping report nothing for a tracked mention: the tracker holds every report
  about the Agent's mentions while the Stop runs (a Stop always completes), then forgets what it had
  not drained (received, pending, kept, queued behind a notice) with those reports. The cloud settles
  it: a person's Stop settles the Agent's pending mentions as not launched, any other stop leaves them
  pending for the cloud to issue again, under the same delivery id, to the next launch.

## Restart and launch

- A restart of the process (`RuntimeRelease`) keeps the mentions it had not settled for the next
  launch (`mention-carry.ts`): after the process is gone, one still being told, or waiting, always; one
  already told during a turn only when the next launch starts a fresh session. A mention arriving while
  the runtime ends or a launch is in flight is held against the launch and session last reported and
  a repeat adopts its newer envelope. A notice that settles for a process the restart replaced never
  refuses its mention.
- The launch tells every kept mention once, in the same notice as the deliveries held for it
  (`AgentLaunchCustody.flushSurvivingDeliveries`, or the lazy `carried` input item when the recovery
  pass did not run first), by delivery id and without checking its envelope again, so each is ACKed
  with its latest envelope. The recovery notice for a wake message or resume messages stays its own.
  The `carried` item does nothing when the recovery pass already told the mentions, and presenting
  what a launch kept never ends a turn already open: the Agent stays busy (a notice the daemon just
  wrote, or the provider's `hasLiveTurn`), and a queueing provider's held deliveries wait for the
  turn's end.
- A kept mention counts as work parked for the launch, so a cold idle or config-apply stop wakes the
  Agent for it. While any mention of the Agent is open (received, pending or kept) the Agent is not
  idle for those stops (`trackedMentionOpen`).
- At most 4096 mentions are remembered, oldest first; a mention issued again after it was forgotten is
  judged afresh. One terminal report is sent per delivery issue (delivery id, launch and session).

## Runner and credentials

A runner hold queues a tracked mention unacknowledged like any delivery; one still queued for an Agent
without a session when the hold lifts is refused `IDENTITY_UNKNOWN`. A tripped fingerprint fence, an
offline record and a stopped Agent refuse at once as `IDENTITY_UNKNOWN`: the reference Computer has no
identity to hold it for either.

While the Agent's provider credential is known invalid (`credential_invalid`,
[the hold](../observability/agent-status-and-activity/credential-invalid-hold.md)) its process is
kept and a mention for it is kept too, as the reference Computer's `credentialInvalidHold` does: the
identity checks run as for any live process, then the entry is carried for the next launch
(`carry.hold`, which keeps even a mention already told) with `daemon_received` and no ACK and no terminal
error. This comes before the busy and backoff checks, so a mention arriving mid-turn is kept too, and a
repeat adopts the newest envelope and is reported `coalesced`. A closed Agent keeps it the same way
(`providerHeld`), without waking. The hold ends when the credential is known usable again (a Stop, a
login or changed credentials, a model change, model output of a later turn) or an hour after the
process closed; the Agent is then told what it kept once, in the same notice as the deliveries held
for it (a live one by `flushSurvivingDeliveries`, a closed one by its launch). A Stop forgets them
without a report, an inbox purge refuses them `DELIVERY_REJECTED`, and the held Agent is not busy for a
pushed configuration or the cold idle stop, which do not wake it.
