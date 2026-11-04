# Task board

These rules apply to `src/server/tasks/`. The framework-free shared Task
contract is `packages/coforge-sdk/src/internal/tasks.ts`.

- A comment author seat is never a Task destination. Task scopes keep `TASK_SCOPE_WHERE` (channel or DM only), including create and conversion; a person's scope is `readableConversationWhere` (a private channel they are not in is a missing one); a comment Conversation id is refused exactly like a missing one.
- `TaskBoard.execute(principal, command)` is the single place for Task
  authorization, atomic message and Task creation, numbering, exclusive claims,
  assignment, card amendments and history, resource receipts, and status
  writes. Agent Task RPC adapters under `server/agents/` call the same
  TaskBoard and never duplicate its business rules.
- `TaskBoard` keeps `execute` (dispatch and entry points) and hands each operation a `TaskBoardPorts` (database, reader, publishers; `task-board-ports.server.ts`): `task-scope.server.ts` resolves the acting conversation and member, `task-list.server.ts` reads `list`, `task-creation.server.ts` creates (and announces a sent message's Task), `task-claims.server.ts` converts, claims and unclaims (and `refuseUnclaimed`), `task-assignment.server.ts` assigns and unassigns, `task-amendments.server.ts` moves status, amends, reads history and deletes, `task-resource-receipt.server.ts` records resource receipts. Shared by them: `task-change.server.ts` (guarded Task write, history events, execution session), `task-notice-posting.server.ts` (`withNotices`), `task-publication.server.ts` (realtime, delivery and receipt publication), `task-assignees.server.ts` (assignee and manager lookup) and `task-request-ids.server.ts` (derived request ids). Blockers and subtasks (`task_dependencies`, `task_parents`; the two Tasks may be in different conversations of one Workspace, and a row cascades with either Task): `task-relations.server.ts` reads them (a page's blockers, parent and subtask progress in three queries, `show`'s dependents and subtree), `task-relations-write.server.ts` validates and writes them (same Workspace, readable by the actor, no self edge, no cycle, at most 20 blockers and 5 levels; `task-relation-graph.server.ts` walks the Workspace's edges), and `task-gates.server.ts` holds what they hold back and the notices they send. They are part of Tasks v2 (the `taskConversations` experiment): off, `execute` refuses `blockedBy`, `parent` and `ready` (`task_relations_off`), no gate or notice applies and views carry no relation data; rows already written wait for it to be switched on. The experiment is read once per `execute` (`withExperimentRead`).
- Relations across channels: a command names a Task as `{number, channel?}` (no channel: the command's own conversation). A channel is resolved by name in the Workspace and must be readable by the actor (`visibleChannelWhere`); a missing Task, a missing channel and an unreadable one are refused with the same "does not exist", so nothing of a private channel shows. A DM's Tasks are named only from that DM. **Lock order, the rule for every Task write in a Workspace with Tasks v2 on** (create, convert, claim, status move, assign, amend, delete): first the Workspace's task-write lock (`lockWorkspaceTaskWrites`, a `pg_advisory_xact_lock`), then conversation locks, the write's own and the other conversations it posts notices into (`NoticeWriter.prepare` locks those in ascending id order once the Tasks to tell are known). Never a conversation lock before the Workspace's. A status move in one channel can wake a Task in another, and the cycle and depth checks read the whole Workspace's edges, so all Task writers of the Workspace are serialized by that lock; this is also why the order cannot deadlock: a plain message send holds one conversation lock and never waits for another lock while holding it. A Workspace with Tasks v2 off takes only the conversation lock, as before. A view names a related Task as `{hidden: false, number, channel, title, status}` (`channel` null for the viewed Task's own conversation, otherwise the channel's name) only when it is in that conversation or in a public channel; otherwise it is `{hidden: true, status}`. History events and refusals follow the same rule. Every notice, a Task in another conversation's included, is posted in the write's own transaction (`withNotices`, the other conversation locked as above), so it exists exactly when the change does, and its fixed id makes a retry post it once; only realtime and push publication follow the commit, best-effort; realtime copies of neighbours go to their own conversation's audience (`announceNeighbours`).
- `task-assignment-authority.server.ts` owns current Workspace-role permission for assignments affecting other actors (owner/admin humans or Agents). Ordinary members may assign/release only themselves; Web reads the same predicate. Assignment preserves status, clears claimedAt, and the reserved holder must claim.
- `task-command-validation.server.ts` (`validateTaskCommand`) owns the shape
  a `TaskCommand` must have, which `execute` checks before it reads anything:
  a malformed one is `INVALID_INPUT`. It reads no database and decides no
  authorization; who may act on which conversation stays in TaskBoard.
- `labels.server.ts` owns Workspace task labels: the rows (a name unique case-insensitively per Workspace and one Badge color), resolution by name for a Task command (an unknown name is refused, never created), the five-per-task cap, and who creates (any member) or renames and deletes (owner or admin) one. `TaskView.labels` carries them; a Task write records `labels_changed`.
- `task-priority.server.ts` owns who sets a Task's priority (`urgent|high|medium|low|none`, default `none`; a CHECK holds the five): anyone who may speak in the conversation, an Agent only on a Task it created or in a channel it coordinates (`coordinatorAgentId`), a Workspace owner or admin always (`task_priority_denied`). `create` takes it, `update` sets it with or without a status (the same priority again writes nothing), history records `priority_changed`, and both `list` forms sort by it, highest first, then oldest first (`byPriority`).
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
- A `delete` is a marker first (task #512): `deletedAt` plus the deleter
  (`deletedByMemberId`, or `deletedByUserId` for a member-less admin) hides the
  Task from every board, list and Agent read (`deletedAt: null`) for a
  one-minute undo window while its children, dependencies and references stay
  intact — a marked Task's references read `deleted` to everyone. `restore`
  clears the marker under the same authority and writes no record.
  `DeletedTaskSweep` (`deleted-task-sweep.server.ts`, the
  `ensureDeletedTaskSweep` background sweep) removes each marked row once the
  window passes — `FOR UPDATE SKIP LOCKED` claims it, the delete's original
  released/subtask-deleted notices post in the same transaction, and the row
  goes with them; one failure never stalls the others. The deleter a marker
  names supplies the notices' actor, a member-less admin by userId — `Member.id`
  is `null` for it, `memberId(member)` refuses a member-keyed write, and the
  `task_board` scope hands a Workspace owner or admin such a member on a public
  channel they never joined; a private channel is refused by the readable
  scope already.
- Blockers and subtasks are server rules for everyone but a Workspace owner or admin: a Task with
  a blocker not done or closed is refused a claim (reason `blocked`, `blockedBy` lists the open
  numbers) and a status move to In Progress, In Review or Done; a Task with a subtask not done or
  closed is refused a move to In Review, Done or Closed (`CONFLICT`, the hint names what blocks it
  and what happens next). Changing a Task's `blockedBy` or `parent` is for its owner, its creator
  or a manager (`ACCESS_DENIED`); other refusals are `INVALID_INPUT` naming the Tasks. A write
  that changes what other Tasks' views read (a status move or title, a delete, a re-parent)
  announces their new copies in the same `task.changed.v1`.
- `claim` answers every selector with a result row and never throws for a
  refused one: `reason` says why (not found, done, closed, held, blocked), and a Task
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
  conversation, except a composer's "Send as Task", which posts none (as on
  Raft: the message shows as its Task); claims, status moves and unassignment post in the Task's own
  thread. `unclaim`, `delete`, `amend`, the resource `receipt`, `history`,
  `list` and no-op writes post nothing, except that an `amend` which gives a started Task an
  unfinished blocker posts the notice below. Delivered and pushed notices, each to one member only
  and posted in the Task's own thread (`NoticeWriter.toOwner`; with no owner it is posted and
  delivered to no one; the member who caused it is not woken): the assignment receipt; "`#N` is
  finished, so this can start" to the owner or reserved assignee when a status move to done or
  closed satisfies the Task's last open blocker; "now blocked by `#N`" to the owner of an
  In Progress or In Review Task that an amendment gave an unfinished blocker; and "all subtasks
  are finished" to a parent's owner when its last open subtask is done or closed. A person
  addressed hears of it through `activity.changed.v1` (it is their Activity mention). No notice counts unread, so every notice's
  message signal reaches only the conversation's own realtime channel.
- Every Task write also announces the new copies of the Tasks it changed, or
  the ids it deleted, as `task.changed.v1` (`ConversationRealtime.taskChanged`),
  routed by `conversationSignalScopes`: a public channel's to the Workspace
  channel, a private channel's to each of its active people, a User–Agent direct
  message's to its human viewer only, one between people to each member, and
  nowhere for any other direct conversation or a private channel with nobody in
  it (it never falls back to the Workspace for Task content). Its publication key
  differs from the message signal's on the same channel, which Centrifugo would
  drop as a duplicate. The
  browser and Agent task routes both give TaskBoard the realtime port; the Agent
  route gives it no delivery publisher or push notifier.
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
- The idle task reminder (`POST /api/agent/v1/tasks/idle-nudge`, Tasks v2 only; off answers
  `disabled`, never 404, which a Computer reads as "no such route") lives in
  `task-idle-reminder.server.ts` (rules, text, recording) and `task-idle-reminder-facts.server.ts`
  (what it reads, over `ownTaskScope`). Its memory is `task_idle_reminders`, written when it
  answers `send: true`, for the listed Tasks only. In review counts as open unless the Agent put
  it there itself; a Task with an open blocker or subtask is never stale. `why` is English.
- An assignee is bound by id wherever it was picked (the browser sends
  `user:<id>` or `agent:<id>`); a bare `@handle` (the Agent CLI) resolves
  within the conversation, and when a person and an Agent share the name the
  person is meant, as an unbound mention resolves. Never send a handle for a
  pick: usernames are global and Agent names per Workspace, so they can clash.

- A platform assistant delegates Task operations to its bound member; `mine` then means that member's Tasks in conversations they may read. Ordinary Agents retain their own Task scope.
