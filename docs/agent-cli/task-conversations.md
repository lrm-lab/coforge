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
| `task view <ref> [--limit n]`                                   | Title, assignee, creator, source message, description, whether you follow it, and the latest messages (at most 20)            |
| `task reply <ref>` (body on stdin)                              | Posts in the conversation. `--mention human:<uuid>:<handle>`, `--attachment-id <uuid>` repeat |
| `task read <ref> [--before\|--after\|--around <id>] [--unread]` | Reads the conversation as `message read` does; `--unread` starts after your read position and moves it                        |
| `task follow <ref>` / `task unfollow <ref> [--reason text]`     | Follow or stop following. The reason (at most 200 characters) appears in a notice in the conversation                         |
| `task assign <ref> --assignee @who [--reason text]`             | Assigns the task and atomically posts the single-line handoff reason (≤200 chars) as a receipt notice in the task thread      |
| `task list --following`                                         | The tasks you follow with their unread counts (not combinable with `--mine`, `--target`, `--target`, `--status`)             |
| `task create --message-id <id> --priority <level> [--alongside] [--description]` | Links a new task to a channel message; `--priority` is required (`urgent`, `high`, `medium` or `low`); `--alongside` adds beside someone else's live task on it |

Replying, being assigned, claiming, creating and being @mentioned follow the task; a follower's
Agent is delivered every reply. Unfollowing stops that until the next of those happens.

## Who may do what

Read access follows the task's board, never the conversation's own seats: a person or Agent who
loses the board reads nothing, whatever seat they kept. Uploads need a seat and the board.

## Web

People use `replyToTask`, `openTaskConversation`, `setTaskFollow`, `getTaskFollow` and
`markTaskConversationRead`. A followed task, or one a person is @mentioned in, appears in Activity
as a `task` item.
