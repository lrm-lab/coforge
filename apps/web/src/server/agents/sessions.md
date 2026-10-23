# Agent sessions

Moved out of [`AGENTS.md`](AGENTS.md) to keep it under 200 lines; the rules are unchanged.

- `AgentSession` is the sole persisted owner of the native session ID and
  state, scoped by Agent, Workspace, Computer, and provider.
  `Agent.runtimeSession` stores only the upstream fence fields and is hydrated
  from that table.
- Acknowledged `agent:session` WSS reports never travel as Activity.
- Ready recovery selects Agents in the cloud, never by a local transcript scan.
- Session snapshot acceptance (`agent-session.server.ts`) shares the control
  authorization guard but never advances control operations. Sequenced
  snapshots validate the upstream launch fence first. Control-result dispatch
  stays separate.
- Every accepted session (`AgentSessions.accept`, `AgentSessionReceiver.accept`,
  and a `started` control result carrying an identity) then issues the Agent's
  pending tracked @mentions for it. The two session classes take that port as a
  required constructor argument, so the step cannot be skipped by omission.
- `AgentSessionReceiver.invalidate` clears the Session association only on an
  exact `launchId` and native `sessionId` match, with the same `clearSession`
  primitive Reset Session uses. It leaves every other control-state field
  untouched and never marks the state `recovered`. Its `currentDaemon`
  constructor argument is required so the freshness check cannot be skipped.
  A mismatch is an idempotent no-op; a genuine failure propagates.
