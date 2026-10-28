# Task-scoped Agent sessions

A channel's coordinator setting enables isolated execution for new Agent claims when its
Computer supports task sessions. Ordinary questions still use standing chat. No second mode
switch is needed. Agent identity, membership and permissions remain unchanged.

## Handoff and execution

- A new claim or self-assigned task in a coordinated channel opts into isolation. The daemon
  advertises support on that command; older Computers keep their current behavior.
- A successful claim returns the task brief and an independent-session receipt. The standing
  turn yields after its tool receipt, once other tools and background work finish.
- Each task attempt gets a fresh provider session. Task sessions and standing chat take turns
  using the Agent directory; simultaneous edits in the same directory are serialized.
- Task turns receive their title, description, revision and original thread reference. They
  read referenced evidence and task checkpoints on demand, rather than restoring unrelated work.
- Messages in that task thread resume its native session. Delivery batches separate threads,
  including two tasks in the same channel.
- Provider session identities and task bindings are persisted outside the Agent workspace.
  Restart restores those bindings; Session Reset starts new histories.
- A completed native turn leaves the attempt waiting. Only an authorized Task status change
  marks business completion. Failed attempts retain their records and native identity.

## Coordination and messages

In a coordinated channel, unaddressed Agent progress does not wake other ordinary Agents.
Explicit Agent mentions still route directly, and the Workspace Memory Agent keeps its batched
observations. A human's unaddressed Task-thread reply reaches the current Agent owner.

Task requirements changing delivers the new revision to the worker. Moving to review or a
terminal status notifies a different coordinator. Completion, closure or reassignment sends a
fenced terminal control to the old worker; it releases that scope without a model turn.
Routine progress has no such event. The task card and existing Activity retain status/log visibility.

A coordinator delegates executable work as assigned Tasks. It ends its dispatch turn and
responds again when a result changes the next step, a blocker needs action, or a human asks.
Native work uses the existing provider adapters; no additional orchestrator framework is introduced.

## Persistence and recovery

`TaskExecutionSession` stores one attempt, with a unique `(taskMessageId, agentId, attempt)`.
Claim serialization reuses an active attempt; reopening or releasing/reclaiming a terminal
attempt creates a new row, preserving earlier native ids and outcomes.

A non-null execution `requestId` marks an opted-in attempt. Rows created by older versions stay
legacy, even when their existing owner claims them again during ordinary recovery.
Native reports require current ownership, the exact execution id and attempt, and an active
Task; stale reports cannot revive a closed task or overwrite another owner's attempt.

Task transition messages and delivery eligibility commit with the Task mutation.
`AgentMessageDelivery.taskExecutionSignal` preserves the original attempt fence for replay;
reading the current attempt when replaying an old cancellation would be unsafe.
Local task binding files hold native session references and task briefs, never pending
messages or an external-job queue. Agents keep job ids, receipts and the next action in their
own `notes/tasks/<task-message-id>.md`; resuming a task never authorizes launching a replacement job.

## Rollout and rollback

Deploy the Web migration and API before updating Computers. New Computers add task capability
fields to claim/create commands, which an older strict Web API does not accept. Older Computers
remain compatible with the new Web and execute through their existing standing session.
Existing in-progress legacy Tasks are never silently moved or replayed. New task claims in
coordinated channels use isolation; ordinary channels retain their existing execution path.

The migration adds immutable task signal metadata and changes execution uniqueness to retain
attempt history. A Web rollback to the older uniqueness assumption requires handling multiple
attempt rows first; do not drop those records or roll back that schema on a live task.
Stop task workers and preserve external-job receipts before rolling a Computer back.
The change does not restart an installed Computer or deploy any running environment itself.
