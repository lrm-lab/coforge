# Task conversations

A task can have its own conversation: a hidden conversation (`Conversation.kind` `task_thread`)
that its first reply creates. It is the workroom for the task; the channel message the task was
made from keeps its own thread.

## Turning it on

A Workspace owner or admin switches it on under Settings → Experiments, and only where the
`task-conversations` feature flag is on. The server tells each Agent launch
(`identity.features.taskConversations`) and every delivery (`AgentMessageDelivery.features`)
whether it is on. The commands below are always registered; with the switch off the server
answers 404 with the Workspace's explanation. When the switch changes while a session runs, the
daemon restarts the session first so its standing instructions match, then delivers the input
behind one line starting `CoForge notice: this workspace's features changed:`.

A task made this way sits on no channel message, which a CLI older than Computer 0.1.19 cannot
list (it crashes). So the switch refuses to open while any Computer with an Agent in the
Workspace is older than 0.1.19 or has not reported a version, and names those Computers. While it
is on, an Agent on such a Computer (one added later) is refused every Task request with `426
CLIENT_UPGRADE_REQUIRED`; no task data is sent to it. The minimum is
`TASK_CONVERSATIONS_MIN_COMPUTER_VERSION`.

## A task's ref

`#channel:#7`, or `dm:@name:#7` on a direct board. Always quote it in a shell: an unquoted `#`
starts a comment. Messages from the conversation arrive with `target=<ref>`.
`message send` and `message read` do not take a ref; `attachment upload --target '<ref>'` does.

## Commands

| Command                                                         | Does                                                                                                                          |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `task view <ref> [--limit n]`                                   | Title, assignee, creator, source message, description, whether you follow it, and the latest messages (at most 20)            |
| `task reply <ref>` (body on stdin)                              | Posts in the conversation, creating it on the first reply. `--mention human:<uuid>:<handle>`, `--attachment-id <uuid>` repeat |
| `task read <ref> [--before\|--after\|--around <id>] [--unread]` | Reads the conversation as `message read` does; `--unread` starts after your read position and moves it                        |
| `task follow <ref>` / `task unfollow <ref> [--reason text]`     | Follow or stop following. The reason (at most 200 characters) appears in a notice in the conversation                         |
| `task list --following`                                         | The tasks you follow with their unread counts (not combinable with `--mine`, `--target`, `--channel`, `--status`)             |
| `task create --message-id <id> [--alongside] [--description]`   | Links a new task to a channel message; `--alongside` adds beside someone else's live task on it                               |

Replying, being assigned, claiming, creating and being @mentioned follow the task; a follower's
Agent is delivered every reply. Unfollowing stops that until the next of those happens.

## Who may do what

Read access follows the task's board, never the conversation's own seats: a person or Agent who
loses the board reads nothing, whatever seat they kept. Uploads need a seat and the board.

## Web

People use `replyToTask`, `openTaskConversation`, `setTaskFollow`, `getTaskFollow` and
`markTaskConversationRead`. A followed task, or one a person is @mentioned in, appears in Activity
as a `task` item.
