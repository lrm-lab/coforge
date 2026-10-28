# Agent attention and recovery

The current MVP has no complete per-Agent delivery-ledger table and no local
durable message inbox/outbox. The canonical `Message` plus each conversation
member's read boundary is the recovery model. A daemon ACK means only that
the daemon took custody of the delivery (notified the Agent, holds it for a
later notice or launch, or dropped it for a channel the Agent lost); it does
not mean the Agent read it or that a run completed. A daemon restart loses
what it held, and the next start recovers it from the read boundary, not from
ACK state. Agent read/send uses the independent
HTTPS RPC, and a logical send keeps one `idempotencyKey`: after an uncertain
result the daemon reconciles by that key and replays under it, never under a new one. Agent Activity is a best-effort observation and has no local spool or
database recovery role.

A daemon `ready` replays every still-unacknowledged `AgentMessageDelivery`
(one that never reached the daemon, or was refused) except those of a channel
the Agent no longer actively belongs to (its membership has `leftAt` set);
direct-message deliveries always replay. When an Agent leaves a channel, is
removed from one, or goes private, the server also publishes a best-effort
`AgentInboxPurge` on its daemon control channel so the daemon drops, and ACKs,
what it still holds for those channels. The replay rule is the backstop for a
missed purge, which is not retried.

Task execution deliveries may carry `taskExecutionSignal`: an immutable execution id, attempt and
`changed | ended` kind. Its attempt fence survives replay even after a task is retried. Ending
a task clears its native scope without a model turn. It grants no new Agent permissions.

Terminal task execution controls remain eligible for daemon replay until ACK, but never count
as model unread attention, freshness context or startup recovery messages.
