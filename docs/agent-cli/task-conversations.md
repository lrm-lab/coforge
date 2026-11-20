# Task conversations

A task has its own conversation: a hidden conversation (`Conversation.kind` `task_thread`)
made with the task. It is the workroom for the task; the channel message the task was
made from keeps its own thread.

## Every Workspace

Task conversations apply to every Workspace; there is no switch. The server still sends
`features.taskConversations: true` to each Agent launch (`identity.features`) and every delivery
(`AgentMessageDelivery.features`), because Computers already in production read it; the daemon's
standing instructions always include the task conversations guidance.

A task made this way sits on no channel message, which a CLI older than Computer 0.1.19 cannot
list (it crashes). An Agent on such a Computer is refused every Task request with `426
CLIENT_UPGRADE_REQUIRED`; no task data is sent to it. The minimum is
`TASK_CONVERSATIONS_MIN_COMPUTER_VERSION`.

A task from before task conversations has no conversation until someone opens, replies to or
follows it; the first of those makes it. Its source message's thread stays where it was.

## A task's ref

`#channel:#7`, or `dm:@name:#7` on a direct board. Always quote it in a shell: an unquoted `#`
starts a comment. Messages from the conversation arrive with `target=<ref>`.
`message send` and `message read` do not take a ref; `attachment upload --target '<ref>'` does.
All numbered `coforge task` board commands (`claim`, `unclaim`, `assign`, `unassign`, `update`,
`amend`, `delete`, `restore`, `receipt`, `show`, `history`) also accept a quoted positional
`'<ref>'` directly in place of `--target` + `--number` (for example,
`coforge task claim '#coforge:#7'` or
`coforge task assign '#coforge:#7' --assignee @bob --reason "Take over API wiring"`).

## Commands

| Command                                                         | Does                                                                                                                          |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `task view <ref> [--limit n]`                                   | Title, assignee, creator, source message, description, whether you follow it, and the latest entries of the task's stream: messages and history events together, at most 20 |
| `task reply <ref>` (body on stdin)                              | Posts in the conversation (reconciles on retryable errors via `reconcileOnly`). `--mention human:<uuid>:<handle>`, `--attachment-id <uuid>` repeat |
| `task read <ref> [--before\|--after\|--around <id>] [--unread]` | Reads the conversation as `message read` does, with the history events of the window among the messages; `--unread` starts after your read position and moves it |
| `task follow <ref>` / `task unfollow <ref> [--reason text]`     | Follow or stop following. The reason (at most 200 characters) appears in a notice in the conversation                         |
| `task assign <ref> <@who> [--reason text]`                      | Assigns an existing task (any posting member may hand off); Agents must give `--reason` (≤500 chars) when handing to someone else, refused on self-assign |
| `task update <ref> --status <status> [--reason text]`           | Moves across `backlog`, `todo`, `in_progress`, `done`, `closed` (`in_review` is retired and maps to `in_progress`). `--reason` (≤500 chars) is optional on `backlog` and refused on other statuses |
| `task list --following`                                         | The tasks you follow with their unread counts (not combinable with `--mine`, `--target`, `--status`)                          |
| `task create --message-id <id> [--priority <level>] [--status backlog\|todo\|in_progress] [--description]` | Links a new task to a channel message (a thread reply resolves to its root); `--message-id` is required for Agents, `--priority` defaults to `medium`, and multiple tasks may share a source message |

Replying, being assigned, claiming, creating and being @mentioned follow the task; a follower's
Agent is delivered every reply. Unfollowing stops that until the next of those happens.

## One stream

A task's discussion and its change history are one time-ordered stream: the conversation's
messages merged with the task's history events (`- [event ...]` lines in `task view` and
`task read`; an event at the same instant as a message comes first). History is the single record
of a change: a status move, a claim and an unassign write no message; a notice that addresses someone (an assignment receipt, a blocked or released notice, an
unfollow) stays. A description change shows only as `updated the description`; `task history`
prints the superseded text. `task view --limit` bounds the merged stream, and `hasOlder` speaks for
it. An event belongs to the page holding the first message at or after it and reads just before that message; the page after the newest message has no upper end. A `task read` page lists the events after the newest message older than the page, so none repeats or drops between pages. `--unread` starts at your read position: the events since it show with the new messages, or alone when none came. `task view` ends with `task history` as the way to every recorded change when older entries exist. The
response fields are `recentEvents` (`task view`) and `events` (`task read`), both absent from an
older server.

## Who may do what

Read access follows the task's board, never the conversation's own seats: a person or Agent who
loses the board reads nothing, whatever seat they kept. Uploads need a seat and the board.

## Web

People use `replyToTask`, `openTaskConversation`, `setTaskFollow`, `getTaskFollow` and
`markTaskConversationRead`. A followed task, or one a person is @mentioned in, appears in Activity
as a `task` item.
