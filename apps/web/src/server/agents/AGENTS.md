# Agent server modules

These rules apply to `src/server/agents/`. Centrifugo receivers that feed
these modules have their own rules in `src/server/centrifugo/AGENTS.md`.

## Create, edit, and delete

- Creating an Agent requires Workspace owner/admin (`assertCanCreateAgents`), including when a human commits an `agent:create` action card, and starts it. Its name cannot be the username of a current member of the Workspace: `PrismaAgentRepository.create` refuses it as `agent-name-taken`, so `@name` never names a person and an Agent. A member who joins later can still share an existing Agent's name.
- `manage-agents.server.ts` owns create/edit orchestration: runtime selection, credential-aware restart decisions, and public response redaction. `create-cloud-agent.server.ts` provisions the owner's default cloud Computer, waits for Pi to be available, and creates a private Agent inheriting the Computer’s configured model, reasoning and credentials; a request id keeps retries on one Agent. The flow does not require a model catalog or pin an individual model. `AgentRuntimeCredentials` owns Agent/provider-bound encryption; repositories persist only the completed runtime config, and Server Function composition supplies encryption lazily.
- `agent-environment.server.ts` persists only user-declared environment overrides and applies them by restart. Never collect or upload the local inherited environment.
- An Agent has no uploaded picture: it shows one of the platform mascots. Only its creator picks which (`AgentMascots.set`, the `setAgentMascot` Server Function); `Agent.avatarMascot` is the only PostgreSQL fact and null means the mascot its id chooses. Every surface, server and client, resolves the picture through `agentAvatarUrl(agentId, avatarMascot)` in `features/agents/agent-mascot.ts`, never null: nothing is copied per Agent, so new and system Agents need no avatar step. The ids and file names derive from `features/agents/mascot-contract.ts` (`public/agent-avatars/`), which the server imports without the Rive names in `mascot-rive-contract.ts`; a changed picture ships a new file name rather than overwriting the old one, because the browser caches it.
- Deleting an Agent requires Workspace owner/admin. It takes the runtime lock, writes `deletedAt` durably, then attempts a best-effort Stop. Deletion is soft: Messages, Tasks, and Action cards are preserved, and an Agent row is
  never hard-deleted.
- Every live-view Agent query applies `ACTIVE_AGENT_WHERE`
  (`active-agent.server.ts`), and every mutation and control path calls
  `assertAgentLive`, so a deleted Agent answers the same `NOT_FOUND`
  everywhere except its read-only profile (`PrismaAgentDetailSource`), which
  keeps it with `deletedAt` under the same visibility gate.

## Visibility

- `agent-visibility.server.ts` is the one authorization seam for
  visibility-aware reads and writes: `visibleAgentWhere` (used beside
  `ACTIVE_AGENT_WHERE`), `canSeeAgent` (the same rule in memory), and
  `assertAgentVisible` (throws `AGENT_NOT_VISIBLE` for by-id, name, or handle
  lookups).
- Build an `AgentVisibilityViewer` from a human's existing
  `resolveActorServerRole` lookup or an already-resolved Agent principal. Never
  issue a second query for it.

## Inbox purge

- `agent-inbox-purge.server.ts` (`AgentInboxPurgePublisher`) is the one
  publisher of `AgentInboxPurge` on the daemon control channel. Callers pass
  the Agent and channel ids after the membership write commits; it resolves
  the Computer and `#channel` targets, skips an Agent on no Computer, and logs
  instead of throwing. `ChangeAgentVisibility` sends one purge for every
  channel a public→private change left.

## Control operations

- `agent-control.server.ts` runs Start, Stop, Restart, Reset Session, and Full
  Reset as fixed command chains with receipt-driven state transitions and
  request/epoch fences. Operation progress is not a new Agent status and not a
  durable command mailbox.
- Each operation mints one `launchId` when it enters `starting` and supplies it
  in the Start intent. `authorizeLaunch` is read-only: it verifies that id and
  never writes.
- `authorizeLaunch` also accepts a daemon-initiated wake that resends the exact
  `requestId`/`controlEpoch`/`launchId` of its last completed start-ending
  chain, unless the Agent is user-stopped. It refuses a superseded scope, a
  failed or stopped operation, and a stopped Agent.
- `execute()` authorizes by the actor's current Workspace membership and
  capability: `controlAgentRuntime` (Start, Stop, Restart, Reset Session) for
  any current member; `resetAgentWorkspace` (Full Reset) for owner/admin only,
  even for the Agent's own owner. The internal paths `recover`,
  `publishStart`, `publishStop` (still checked against Agent ownership), and
  `authorizeLaunch` (Workspace/Computer scope only) skip this capability
  check.
- The latest command wins: `begin()` supersedes any non-terminal operation with
  a different `requestId`, and `recover()` (Daemon `ready` reconciliation)
  never supersedes, only republishes. Do not add a pending-operation rejection
  or an abandonment/age concept.
- A superseded caller's `drive()` resolves `phase: "superseded"` instead of
  throwing; `executeAgentControl` throws only on `failed`. `publishStop()`
  throws on supersede because its callers need a confirmed stop.
- Control clears the Session binding at the local chain step.

## Send freshness

- `executeAgentSendMessageWithPolicy` decides on the server what a send does to
  the Agent's inbox. A message is seen when the Agent sent it, when it is at or
  below the reported `seenUpToSeq`, or when it is in `seenExactSeqs`, in either
  freshness mode; the mode only decides what a hold presents.
- A key that already committed is answered from its request record before the
  target or its freshness is read (`reason: "already_committed"`): no later
  change may report a committed send as refused or held.
- When every pending message was already seen, the boundary that may advance
  over them is the larger of the Agent's report and the server's own
  read-through, not the client's boundary alone. The `check` that showed those
  messages already moved the read-through, so this is safe, and it is what
  keeps an Agent's exact set small in the steady "notified → check → send"
  loop.
- `agent-history-boundary.server.ts` is the one contiguity rule for an Agent
  history page: the `modelSeenUpToSeq` it reports and the read-through it moves.
  A page read from an explicit `fromSequence` never joins.

## Stopped Agents

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
  has a message in its creator's DM. Ordinary introductions send one short DM greeting and ask what help is wanted; they do not read memory or list tasks merely to prepare that greeting, and a local final answer never counts as delivery.
- Ready recovery reconciles a stopped Agent the Daemon still runs with a Stop
  through `AgentControl.publishStop`, without blocking the rest of recovery.
- `agent-delivery-rejection.server.ts` answers a Daemon's `no_process`
  delivery rejection. It never starts a stopped or deleted Agent, one with an
  operation in flight (for any configuration), or one whose latest operation
  for its current configuration ended failed after it began a Start or a chain
  ending in one, whatever step failed, a Restart or Reset failing at its stop
  step included. That Agent waits for a person's Start or the next Daemon
  `ready`. Otherwise it sends the same recovery Start as ready recovery.
  `controlOperationState` (`agent-control.server.ts`) reads the control state; the guard stays
  in the receiver, never in `recover()` or `WorkspaceAgentRecovery`, so ready
  recovery still restarts a failed Agent.
- `ManageAgents.update`, `ChangeAgentRuntimeCredential`, and
  `AgentEnvironment.save` skip the stop → persist → start restart for a stopped
  Agent and return `"deferred"`.

## Sessions

See [sessions.md](./sessions.md).

## Display and Activity

- `agent-display.server.ts` is the only reducer from ordered process status
  and authorized Activity to online/working/thinking/error/offline. RPC and
  publication adapters call it and never duplicate its transition rules.
- Expiry uses server receipt time. Working/thinking fall back to online while
  the process lease lives; error remains until recognized activity or reset;
  process lease expiry yields offline. The revision counter persists with a
  Redis server-time floor.
- The reducer's `runtimeSession` launch read is a best-effort fence, not a
  Redis-atomic guarantee.
- `packages/coforge-sdk/src/internal/agent-display.ts` is the browser display contract;
  change it additively.
- `agent:status` carries only `active` or `inactive`; Activity keeps raw
  detail and entries. Backend `activity_kind` classification overrides any
  Daemon-supplied classification.
- Persist every Activity frame except busy heartbeats, liveness-probe replies,
  and `runtime_progress`. Never blank `detail` before persisting.
- Publish Activity and `agent:display` through `agentActivityChannelFor` and
  `agentStatusChannelFor`; never choose the shared or per-Agent channel inline.
- Computer lifecycle rows are the only Activity the server writes itself
  (`computer-lifecycle-activity.server.ts`). A daemon's return row follows
  the server's upgrade and restart records, then the previous version, never
  only its notice. One per daemon instance, none on reconnect; only a failed
  upgrade (error-level `computer_operation_failed`) carries a detail.
- The Activity history cap is the shared `AGENT_ACTIVITY_WINDOW`
  (`features/agents/agent-activity-window.ts`); the browser timeline keeps the
  same number.

## Skills, context, and reminders

- `agent-skills.server.ts` authorizes the Agent owner and correlates bounded
  requests.
- `agent-context-report.server.ts` authorizes through the Agent owner's
  assignment (the Skills/Workspace Files rule) and resolves the launch and
  session from the persisted session reference.
- `agent-reminders.server.ts` is the creator's or Workspace owner/admin's
  browser read model of bounded, scheduled Reminders. Reminder lifecycle stays in
  `server/reminders/`.

## App bots

- An app's bot (`systemKind = app-bot`, `server/app-bots/`) is an Agent with no Computer, made and archived only by its grant. Nothing launches it: `AgentControl` does not find an Agent with no Computer, a delivery with no Computer is not pushed, and `SendDirectMessage` leaves a person's message to a bot for its app's poll. `assertNotAppBot` (`active-agent.server.ts`) refuses the ordinary edit and visibility controls; call it from any new control that could give a bot a Computer or change its visibility.
- Its key authenticates through `authenticateAppBotRequest` before the Computer door, and works only on the routes `app-bot-capabilities.server.ts` lists. A new `/api/agent/v1` route is closed to bots until it is listed there.

## Workspace platform assistants

- `workspace-assistant-onboarding.server.ts` starts new and backfilled assistants on the default cloud Computer using Pi/provider defaults. Web boot reaches old memberships; stopped Agents stay stopped. Platform introductions remain due until their first canonical DM reply; ordinary introductions retain their seven-day window.
- `workspace-assistants.server.ts` owns the Workspace singleton and each member's private execution Agent and DM. Only this provisioning path writes `systemKind = workspace-assistant`; ordinary create/edit APIs never accept it.
- A platform assistant is visible only to its member, including against Workspace admins. Its native sessions, credentials, files and delegated read cursors belong to that member. It cannot become public or be deleted through ordinary Agent controls.
- `workspace-assistant-authority.server.ts` resolves a trusted binding and current membership. Delegated commands use the member's existing use cases and current permissions; leaving invalidates existing credentials. Ordinary Agents retain their own roles and membership rules.
- `workspace-assistant-commands.server.ts` owns delegated conversation commands; `workspace-assistant-http.server.ts` adapts their native CLI wire contracts. Own-assistant DM operations retain normal Agent delivery and attention. Delegated event consumption never advances human unread state.
- Migration targets for a platform assistant must belong to its member. Workspace admins cannot inspect or migrate another member's assistant.
