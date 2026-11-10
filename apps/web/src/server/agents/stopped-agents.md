# Stopped Agents

Moved out of [`AGENTS.md`](AGENTS.md) to keep it under the size limit; the rules are unchanged.

- `Agent.stoppedAt` is the persisted user stop intent, independent of
  `controlState`. Nothing may start or wake a stopped Agent except an explicit
  user Start, Restart, Reset Session, Full Reset, or a channel's "Resume all".
- A person's Stop (`execute` or `stopMany`) settles the Agent's pending tracked
  @mentions as not launched through the `AgentControlMentions` port, after
  `stoppedAt` is recorded; a failure there is logged and never fails the Stop.
- `stop` persists `stoppedAt` before running the stop chain, so the intent
  survives an unresponsive Computer. The other user operations clear it first.
- `stopMany` and `startMany` (a channel's "Stop all Agents" and "Resume
  all", `ChannelAgentControl`) write the same stop or start as `execute` for
  many Agents with the actor's role read once, at most four at a time (each
  holds a runtime-lock connection and a transaction). They send each command
  without waiting for the Daemon and retry a failed send once; an Agent still
  `stopping` is sent its stop again by the next stop. Do not loop `execute`
  over Agents: each call re-reads the role and polls for its receipt.
- `startMany`'s Start carries the user's `resumePrompt` and no message
  recovery, and only on that first send: ready recovery re-sends the same
  Start without it, so the Agent never reads the guidance twice.
- A user `start` carries the same recovery context
  (`conversations.readAgentRecoveryContext`) as a Daemon-ready recovery start.
- Starts carry `introductionPrompt` up to 7 days after `introductionDueAt`,
  which a person's create sets and the next Start settles once the Agent
  has a message in its creator's DM. Ordinary introductions send one short DM greeting and ask what help is wanted; they do not read memory or list tasks merely to prepare that greeting, and a local final answer never counts as delivery. Who welcomes a new member is decided once, when they join, from the Workspace's `onboardingMode` then, and recorded as `WorkspaceMembership.assistantWelcome`; the introduction store reads that record (only for an Agent that may owe an introduction), so a platform assistant gets its welcome prompt only for a member admitted under `assistant`, whatever the mode is later. `newAgentGreeting` adds a #general self-introduction to the prompt of a new public Agent while #general is shown (`greetGeneral`).
- Ready recovery reconciles a stopped Agent the Daemon still runs with a Stop
  through `AgentControl.publishStop`, and isolates each Agent's failure
  (`agent_recovery:agent_failed`): ready fails only when every Agent failed.
- `agent-delivery-rejection.server.ts` answers a Daemon's `no_process`
  delivery rejection. It never starts a stopped or deleted Agent, one with an
  operation in flight (for any configuration), or one whose latest operation
  for its current configuration ended failed after it began a Start or a chain
  ending in one, whatever step failed — except a transient failure inside the
  bounded retry window. Otherwise it sends the same recovery Start as ready
  recovery. `controlOperationState` (`agent-control.server.ts`) and
  `isEligibleForTransientRetry` (`agent-control-types.server.ts`) are the one
  rule both apply; `recover` also supersedes a stale-scope pending operation.
- `ManageAgents.update` and `AgentEnvironment.save` plan through `AgentConfigApply`: a running Agent keeps its process and gets an `AgentConfigSync` after the write, only when `planAgentConfig` finds the fence; otherwise stop → persist → start. Every Start carries `agentConfigRevision`. A runtime credential save or delete always restarts (`ChangeAgentRuntimeCredential`): a leaked key must stop being used at once. Behaviour: [config apply](../../../../../docs/observability/agent-status-and-activity/config-apply.md).

