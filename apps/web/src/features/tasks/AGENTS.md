# Tasks UI

These rules apply to `src/features/tasks/`.

- `use-task-assignment-access.ts` reads the same current Workspace-role predicate as writes. The owner menu (`task-assignee-menu.tsx`, with `task-field-trigger.tsx`) offers other members only to Workspace owners/admins; ordinary members see themselves and cannot take another holder’s Task. The server rechecks every write.
- Every status edit goes through `executeTask` with claim semantics. The
  browser supplies revisions for the optional revision check; the Agent CLI
  need not.
- dnd-kit owns pointer and keyboard drag mechanics only, never authorization
  or persistence.
- The Workspace Tasks page and a conversation's Tasks tab are one component,
  `TaskBoard` (`task-board.tsx`), with one card: the same toolbar, board or
  list, moves and paged Done and Closed. Only the page has its page header
  and shows each Task's source and Project (filter, pill, Display field); only
  a conversation (`ConversationTaskBoard`) creates Tasks. Cards carry no
  Claim or Unclaim button: moving an unowned To do Task to In progress claims
  it (`getTaskMoveCommand`).
- `/tasks` and every conversation page host (through
  `conversationPageSearchShape`) spread `taskBoardSearchShape`, and a Project
  page `projectTaskBoardSearchShape` (`task-board-search.ts`, `channels`
  instead of `projects`), into their validated search, read with
  `useTaskBoardSearch`: `status`, `layout`, `owners`, `labels`, `projects` or
  `channels`, `completed`. A status or layout
  change is a history entry; picks and the window replace the address in
  place. Hidden columns and Display fields are one device preference shared
  by both boards.
- Every status group starts expanded, and any group can be collapsed from
  its header. A collapsed group renders no cards but stays a drop target.
  The choice is not persisted.
- Every group renders its first 50 cards and adds 50 per "Show more"; never
  render a whole status at once. A paged group (Done and Closed on either
  board) renders every card it has read, since each read is at most 50, and
  keeps its own footer instead.
- A card's menu (dropdown, tooltip, delete confirmation) is built only when
  a mouse comes over the card or its stand-in button is tabbed to or pressed
  (`BoardTaskCard`); building one per card was about a quarter of the
  Tasks page's script time.
- Done and Closed come from `useFinishedTasks`, scoped to the Workspace page
  or one conversation: exact server counts for the `completed` window (`week`
  when absent, `month`, `all`) under the owner and Project picks, and
  50-per-page reads with "Load more". `/tasks` reads the counts before its
  board shows. A conversation page's loader (`loadConversationPage`, for Chat's
  routes and the search preview) waits for them only on `cause: "enter"`
  (arriving from any other route, including a first load); on `stay`
  (switching to the Tasks tab, changing the window, or opening another
  conversation of the same kind) it only starts the read, and the board
  waits for it (`pending`) before it may show empty. A board holds a
  finished Task itself only once it showed it unfinished (moved there
  since). `/tasks` holds only unfinished Tasks in its collection, reads Done
  and Closed again after every Task command and `task.changed.v1` burst, and
  fetches a `task` it has not read alone (`loadOverviewTask`).
- A conversation's Tasks are one TanStack DB Query Collection per
  conversation in on-demand sync (`conversation-tasks-collection.ts`, created
  per `QueryClient` by `conversationTasksFor`), read through
  `loadConversationTasks`; nothing reads the whole list. Only live queries
  read, their predicate being the read: the Tasks tab's unfinished ones
  (`useUnfinishedTasks`) and `ConversationTaskDemand` (in
  `ThreadedConversation`): the loaded message window as a sequence range,
  open at the live end so a new message needs no read, the numbers its bodies
  name, and the open popup's number. Never add a live query per row or a
  collection per predicate; a new kind of read is a predicate that
  `conversationTaskSubset` and the server accept. Demands keep their read for
  `DEMAND_GC_TIME_MS` after they stop showing, so a moving window never blanks
  badges.
- Commands and announced changes are written into that collection
  (`useConversationTaskWrites`, the collection's `apply`): announcements
  apply once per burst, a read that started before a change never brings the
  older copy back, and Done and Closed are read again when a burst or command
  may have changed them; the collection holds only what the page shows, so a
  Task it does not hold counts as possibly finished. `query-db-collection`
  1.2.15 copies every held row into each subset's Query cache on a direct
  write (its docs describe a refetch instead): check that again when upgrading
  it.
- A command's result names the Tasks it was given, not the ones the write
  changed beside them: a sub-task's parent, whose progress and tree changed, is
  a neighbour of the command, and only its announcement carries its new copy.
  The popup held its pre-create copy and hid its sub-tasks until a reload
  (task #65). A writer that changes a Task this way reads it again and writes
  its copy the way its own results are written — `createSubtasks` reads the
  parent, as `adoptSubtask` reads its tree — rather than leaving the copy to
  the wire.
- A Task of another conversation (a label in a message, a related Task) opens
  over the page it was pressed on, never on its conversation's page: the
  Workspace layout's `otherTask` search param (`other-task-search.ts`) and its
  one popup (`OtherTaskPopup`), so it works on every page and Back closes it.
  It stacks over a popup already open.
- Cards and list rows carry no status select: the column or group is the
  status. Moves go through drag or the card menu's "Move to" section, which
  both offer every move `getTaskMoveCommand` allows. That helper reads the one
  status table the server uses (`taskStatusMoveAllowed` in the SDK) and the
  viewer's `canSetAnyStatus` from `useCanSetAnyTaskStatus`, so the board never
  offers a move the server answers 403 for, and a Workspace owner or admin is
  offered every status.
- Overview membership metadata only controls which UI actions are offered;
  the server still authorizes each command.
- Task Detail (`task-detail-panel.tsx`) is the shared container-agnostic core;
  `task-detail-dialog.tsx` wraps it in `TaskDetentSheet` (`task-detent-sheet.tsx`,
  64% ↔ 94% GPU-translated bottom sheet with pinned composer portal and
  auto-expand before opening relation pickers) below `64rem` and a right-docked
  drawer on desktop when opened standalone (e.g. `OtherTaskPopup`). On desktop
  (`>= lg`), conversations host it in `ConversationSplit`'s `"task"` slot,
  `WorkspaceTaskBoard` hosts it in a resizable split pane beside `TaskBoard`,
  and `ActivityInboxView` renders it directly in the right preview pane with
  `j`/`k`/`E`/`Esc` flow. Task panels open Agent and person profiles directly
  without a `SlideoutOverlay` drawer (`useTaskPopupProfile`): desktop inline/split
  panels and `DesktopTaskDrawer` host the profile in a right-hand
  `ConversationSplit` pane, while `MobileTaskSheet` pushes it full-screen from the
  right edge with swipe-back. It offers only the status moves `taskStatusOptions`
  (`task-move.ts`) allows; board drags keep every move the server allows. Its
  thread comes from the Task's conversation: a conversation page renders it, and
  `OverviewTaskPopup` / `ActivityTaskPopup` render that conversation's own view
  through `ThreadedConversation`'s `taskPopup` mode (passing `inline` on desktop
  splits). The Task (title, description, sub-tasks) is the `lead` at the head of
  the discussion pane's own scroller, never a wrapper scroller around it, so
  anchoring, the bottom pin and jumps keep working. The panel opens at the top;
  unread replies show only as the new-messages pill, counted by the server, and
  the read position moves only when the latest reply comes into view. Properties
  render as a chip row in split/sheet/drawer modes and move into a `w-72` right
  sidebar when expanded (`⤢`) at `>= 64rem`. Full History is in the `⋯` menu,
  in place of the left column. Never build a second thread view for a task. A
  Task whose message is outside the loaded window has its message read alone
  (`useTaskPopupRoot`); opening a task never replaces the stream's window.
- `/tasks` names its open popup as `task=<conversationId>:<number>`
  (`task-overview-search.ts`); a conversation route's `task` is the bare
  number. Opening pushes a history entry, closing replaces it.
- `/tasks` rows are a TanStack DB collection over the `["task", "overview",
workspaceId]` Query its loader fills (`task-overview-collection.ts`,
  `use-task-overview.ts`). Commands go through the collection's `run`, which
  shows a move at once and writes back the server's copy; refreshes
  invalidate that Query, never the router. A command with nothing to show
  first still reaches the server: an empty optimistic transaction is never
  saved. Announced Task changes (`task.changed.v1`, `task-realtime.ts`) are
  applied to the rows with `apply` in one write per burst; only an unfinished Task the
  page does not list yet reads the list again.
- The board's toolbar (`task-toolbar.tsx`) has one "Filter"
  menu (owner, Project, status submenus) with a removable chip per filter in
  use, and a board or list switch in the bar (Frank, 11-06: nothing else to
  set; a card's fields are fixed).
- Filters are search params, comma-separated: `owners` holds User or Agent
  ids and `projects` holds Project ids, with `none` meaning no owner or no
  Project (`task-filters.ts`).
- Read [Tasks board rows, cards and hidden columns](../../../../../docs/design/tasks-board.md) when changing a task row, card, status icon or `TaskNumberBadge`.
- A message row's part reads its Tasks through `useNumberedTask` /
  `useMessageTasks`, selectors over the collection's TanStack Store (`byId`,
  `byNumber`, `bySource`, where an unchanged Task keeps its object), never from a list
  passed down. A message's Tasks are those made from it
  (`sourceMessageId`), which a message window reads by that message's sequence, rendered as a compact bordered list card under the message. They never read anything themselves, so a row adds no request.
  A body's task reference whose number the collection does not hold yet opens
  the Task on a press; it is the plain words only once a read
  by number has answered without it or its Task was deleted (`missing`).
- Read [Tasks board rows, cards and hidden columns](../../../../../docs/design/tasks-board.md) when changing hidden board columns (`HiddenColumn`, `task-hidden-columns.ts`).
- The Workspace board shows the channels' Tasks the viewer may read and their
  own direct conversations'; another person's DM never shows. The
  server scopes every Workspace-page read; realtime applies the Workspace
  channel's announcements and every one on the viewer's own channel.
  The page creates no Tasks: new ones start from a conversation's Tasks tab
  (`CreateTaskDialog`, laid out as the Task popup: where it goes, a To do title, owner and
  label chips, a description). One Task per dialog, which replaced several titles at once
  (Frank, 11-05). Its Project follows the conversation and is changed in the popup.
- Blockers, parent and sub-tasks show on every card from the Task's
  own view (`blockedBy`, `blocked`, `parent`, `subtasks`) and in the popup (`TaskSection`:
  `task-relation-lines.tsx`, with `use-task-relations.ts` for the `show` read of `blocking` and
  `subtree`, keyed by revision, and the commands). The pure rules are `task-relation-edits.ts`.
  Blockers are edited by `amend` with the whole new `blockedBy` set (`TaskRef[]`, a bare number in the
  Task's own conversation, `channel` otherwise) and the Task's revision. A hidden blocker has no ref,
  so a Task waiting for one can be read but its blockers are neither removed nor added to
  (`blockerRefs`): the amendment would drop it. Pickers (`task-picker.tsx`) list this conversation's
  unfinished Tasks, and a search reaches other channels' from the Tasks page's read
  (`useTaskCandidates`, read only while a picker is open). The parent picker lists only the Tasks the
  viewer may add a sub-task under (`canBeParent`: its owner, its creator, or a Workspace owner or
  admin, decided with the viewer's member id in that Task's conversation), so it never offers one the
  server would refuse. A refusal's sentence never reaches the
  browser; the popup's error line words only `relationRefusal`'s two kinds.
