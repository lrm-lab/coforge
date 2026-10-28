# Task board

These rules apply to `src/server/tasks/`. The framework-free shared Task
contract is `packages/coforge-sdk/src/internal/tasks.ts`.

- `task-conversation-scope.server.ts` owns task conversation lookup and current membership authority.
- `task-execution.server.ts` owns isolated execution opt-in and attempt-fenced native reports;
  `task-execution-events.server.ts` owns atomic task transition deliveries and their publication.
  A native turn ending means waiting, never business completion. Existing legacy work remains legacy.

- A comment author seat is never a Task destination. Task scopes keep `TASK_SCOPE_WHERE` (channel or DM only), including create and conversion; a comment Conversation id is refused exactly like a missing one.
- `TaskBoard.execute(principal, command)` is the single place for Task
  authorization, atomic message and Task creation, numbering, exclusive claims,
  assignment, card amendments and history, resource receipts, and status
  writes. Agent Task RPC adapters under `server/agents/` call the same
  TaskBoard and never duplicate its business rules.
- `task-assignment-authority.server.ts` owns current Workspace-role permission for assignments affecting other actors (owner/admin humans or Agents). Ordinary members may assign/release only themselves; Web reads the same predicate. Assignment preserves status, clears claimedAt, and the reserved holder must claim.
- `task-command-validation.server.ts` (`validateTaskCommand`) owns the shape
  a `TaskCommand` must have, which `execute` checks before it reads anything:
  a malformed one is `INVALID_INPUT`. It reads no database and decides no
  authorization; TaskBoard uses the task conversation scope module for membership authority.
- `task-view.server.ts` owns how a stored Task reads: its selection, its
  `TaskView`, and its stored status. `task-history.server.ts` owns which
  history events a Task write records and how they read back. TaskBoard and
  the Activity inbox read Tasks through them; do not map a Task row or parse
  its status anywhere else.
- A Task's text (its title, a history title change) keeps its message's
  mention tokens and is read per reader (`TaskReader`): people see a mentioned
  person's name, never their username; an Agent sees their `@handle`.
  `TaskBoard` reads for people unless the Agent Task route passes
  `reader: "agent"`; a realtime Task copy always reads for people.
- `claim` answers every selector with a result row and never throws for a
  refused one: `reason` says why (not found, done, closed, held), and a Task
  another member holds adds `conflict` (holder, `claimedAt`, `observedAt`),
  read in the refusing transaction. Only the browser seam (`executeTask`
  calling `refuseUnclaimed`) turns a claim that claimed nothing into an error.
- Resource expiry follow-up uses the existing Reminder persistence and
  synchronization. Never add a second task scheduler.
- TaskBoard creates the server-authored assignment Message and the assignee's
  delivery eligibility in the same transaction. An Agent that assigns itself
  gets no delivery: the receipt is in its command result, and it never wakes itself.
- Task writes post their server notice (wording in `task-notices.server.ts`)
  through `withNotices`, which holds the conversation lock and signals open
  pages after the commit. Creation, conversion and assignment post in the
  conversation; claims, status moves and unassignment post in the Task's own
  thread. `unclaim`, `delete`, `amend`, the resource `receipt`, `history`,
  `list` and no-op writes post nothing. Assignment receipts and actionable isolated-task events are delivered; only assignment receipts are pushed, and a person assigned hears of it through `activity.changed.v1`
  (it is their Activity mention). No notice counts unread, so every notice's
  message signal reaches only the conversation's own realtime channel.
- Every Task write also announces the new copies of the Tasks it changed, or
  the ids it deleted, as `task.changed.v1` (`ConversationRealtime.taskChanged`),
  routed like its conversation's messages by `messageSignalScope`: a channel's
  to the Workspace channel, a User–Agent direct message's to its human viewer
  only, one between people to each member, and nowhere for any other direct
  conversation (`conversationSignalScopes` never falls back to the Workspace for
  Task content). Its publication key
  differs from the message signal's on the same channel, which Centrifugo would
  drop as a duplicate. The
  browser and Agent task routes both give TaskBoard the realtime port; the Agent
  route gives it a delivery publisher for assignment and actionable execution events, but no push notifier.
- A null Message sender is the server identity, never a fabricated member.
  Authenticated send adapters always supply their member identity. Message
  reads and browser projections expose the server identity as `system` without
  changing Agent-send wake rules.
- Task message metadata belongs to the existing message read projections.
- The Workspace Tasks page's reads (`overview`, `overviewTask`, `finishedSummary`,
  `finishedPage`) and a conversation page's `conversationTasks` (some
  statuses, a message sequence range, some numbers; at least one, never the
  whole list) live in `task-overview.server.ts` (`TaskOverviewReads`);
  `TaskBoard` keeps them as entry points and lends it the `list` authorization
  for a one-conversation read, so Task authorization stays in TaskBoard.
- `TaskBoard.overview(workspaceId, userId)` is browser-only. It reads visible
  channels only; a direct message's Tasks stay on that conversation's Tasks tab,
  and every Workspace-page read (`overviewTask`, `finishedSummary`,
  `finishedPage` without a conversation) shares that scope. It returns
  unfinished Tasks only, newest first;
  Done and Closed are read through `finishedSummary` (counts by status, owner
  and Project) and `finishedPage` (50 per page, newest update first, cursor
  `(updatedAt, messageId)`), both limited to a `week | month | all` window
  and scoped to the Workspace page or one conversation. The Agent `list`
  command keeps its own semantics.
- An Agent's own list (`list` with `mine`) returns every Task assigned to it in
  the conversations it is a member of, unfinished by default and without a page
  limit. Its `coverage` and `pagination` describe that query and come from
  `ownTaskScope` beside it; change the two together.
- An assignee is bound by id wherever it was picked (the browser sends
  `user:<id>` or `agent:<id>`); a bare `@handle` (the Agent CLI) resolves
  within the conversation, and when a person and an Agent share the name the
  person is meant, as an unbound mention resolves. Never send a handle for a
  pick: usernames are global and Agent names per Workspace, so they can clash.

- A platform assistant delegates Task operations to its bound member; `mine` then means that member's Tasks in conversations they may read. Ordinary Agents retain their own Task scope.
