# Realtime events: who publishes, who receives

Part of [the documentation index](../README.md).

Every browser realtime event is a versioned `*.v1` message published over Centrifugo. This table
is the one place to see, for an event's content, every publisher and every receiver.
`apps/web/test/realtime-event-catalog.test.ts` fails when a server event is missing from the
table or a table row names no server event, so adding or renaming an event forces this list to
change with it. The shared dispatcher (`features/conversations/conversation-realtime.ts`) is
omitted from the receiver column; it only routes each event to the feature files listed here.

| Event | Publisher | Receivers |
| --- | --- | --- |
| `activity.changed.v1` | `server/tasks/task-publication.server.ts`, `server/conversations/conversation-realtime.server.ts` | `features/inbox/activity-inbox-queries.ts` |
| `agent.changed.v1` | `server/agents/agent-visibility-realtime.server.ts` | `features/agents/agent-status-channel.ts` |
| `artifact.version.published.v1` | `server/artifacts/artifact-signals.server.ts` | `features/artifacts/artifact-realtime.ts` |
| `channel.created.v1` | `server/conversations/conversation-realtime.server.ts` | `features/tasks/use-task-overview.ts`, `features/conversations/use-channel-unread.ts`, `features/conversations/conversation-unread.ts`, `features/conversations/conversation-queries.ts`, `features/conversations/sidebar-collections.ts`, `features/conversations/channel-signals.ts`, `features/conversations/channels.functions.ts`, `features/conversations/conversation-navigation.tsx`, `routes/w.$workspaceSlug/_chat.tsx` |
| `channel.joined.v1` | `server/conversations/channel-lifecycle.server.ts`, `server/conversations/channel-membership-signals.server.ts` | `features/tasks/use-task-overview.ts`, `features/conversations/conversation-unread.ts` |
| `channel.left.v1` | `server/conversations/channel-membership-signals.server.ts` | `features/conversations/conversation-unread.ts`, `features/conversations/sidebar-lists.ts`, `features/tasks/use-task-overview.ts` |
| `channel.marked.v1` | `server/inbox/activity-attention.server.ts`, `server/conversations/channel-read.server.ts` | `features/conversations/conversation-unread.ts` |
| `channel.closed.v1` | `server/conversations/channel-preferences.server.ts` | `features/conversations/sidebar-lists.ts`, `features/conversations/sidebar-signals.ts` |
| `channel.opened.v1` | `server/conversations/channel-preferences.server.ts`, `server/conversations/chat-sections.server.ts` | `features/conversations/sidebar-lists.ts`, `features/conversations/sidebar-signals.ts` |
| `channel.updated.v1` | `server/conversations/channel-project.server.ts`, `server/conversations/conversation-realtime.server.ts` | `features/tasks/use-task-overview.ts`, `features/conversations/use-channel-unread.ts`, `features/conversations/conversation-unread.ts`, `features/conversations/conversation-queries.ts`, `features/conversations/sidebar-collections.ts`, `features/conversations/sidebar-signals.ts`, `features/conversations/channel-signals.ts`, `features/conversations/channels.functions.ts`, `features/conversations/conversation-navigation.tsx`, `routes/w.$workspaceSlug/_chat.tsx` |
| `conversation.activity.v1` | `server/conversations/conversation-realtime.server.ts`, `server/conversations/conversation-activity.server.ts` | `features/inbox/use-activity-inbox-realtime.ts`, `features/conversations/sidebar-lists.ts`, `features/conversations/conversation-unread.ts`, `features/conversations/conversation-activity-event.ts`, `features/conversations/sidebar-signals.ts` |
| `conversation.read.v1` | `server/conversations/conversation-read-realtime.server.ts` | `features/conversations/use-read-ticks.ts` |
| `dm.created.v1` | `server/conversations/direct-conversations.server.ts`, `server/db/repositories/user-agent-direct.repositories.server.ts` | — |
| `dm.opened.v1` | `server/conversations/direct-conversations.server.ts`, `server/conversations/chat-sections.server.ts` | `features/conversations/sidebar-lists.ts`, `features/conversations/sidebar-signals.ts` |
| `dm.closed.v1` | `server/conversations/direct-conversations.server.ts` | `features/conversations/sidebar-lists.ts`, `features/conversations/sidebar-signals.ts` |
| `dm.marked.v1` | `server/inbox/activity-attention.server.ts`, `server/conversations/direct-conversations.server.ts` | `features/conversations/conversation-unread.ts` |
| `member.changed.v1` | `server/conversations/conversation-realtime.server.ts` | `features/conversations/channel-conversation.tsx`, `features/conversations/use-channel-mentionables.ts` |
| `message.available.v1` | `server/conversations/conversation-realtime.server.ts` | `features/conversations/use-task-conversation.ts`, `features/notifications/in-page-notifications.ts` |
| `message.reaction.v1` | `server/conversations/reaction-write.server.ts`, `server/conversations/conversation-realtime.server.ts`, `server/conversations/conversation-history.server.ts` | `features/conversations/message-reactions.functions.ts`, `features/conversations/conversation-messages.ts` |
| `notification.available.v1` | `server/notifications/in-page-notification-publisher.server.ts`, `server/notifications/web-push-notifications.server.ts` | `features/notifications/in-page-notifications.ts`, `features/notifications/notifications.functions.ts` |
| `pref.changed.v1` | `server/conversations/chat-sections.server.ts`, `server/conversations/conversation-pins.server.ts`, `server/conversations/direct-conversations.server.ts`, `server/conversations/channel-preferences.server.ts` | `features/inbox/use-activity-inbox-realtime.ts`, `features/conversations/conversation-unread.ts`, `features/conversations/chat-sections.ts` |
| `record.changed.v1` | `server/records/key-point-extraction-write.server.ts` | `features/records/record-realtime.ts`, `features/records/use-record-changed-refresh.ts`, `features/records/records.functions.ts` |
| `runtime-auth.login.v1` | `server/computers/runtime-auth.server.ts` | `features/computers/runtime-auth-realtime.ts`, `features/computers/runtime-sign-in-dialog.tsx`, `features/agents/agent-create-dialog.tsx` |
| `runtime-auth.logout.v1` | `server/computers/runtime-auth.server.ts` | `features/computers/runtime-sign-out-dialog.tsx`, `features/computers/runtime-auth-realtime.ts` |
| `runtime-auth.status.v1` | `server/computers/computer-runtime-auth.server.ts`, `server/computers/runtime-auth.server.ts` | `features/computers/use-runtime-auth-signals.ts`, `features/computers/runtime-auth-realtime.ts` |
| `saved.added.v1` | `server/conversations/saved-messages.server.ts` | — |
| `saved.removed.v1` | `server/conversations/saved-messages.server.ts` | — |
| `label.group.changed.v1` | `server/tasks/label-signal.server.ts` | `features/tasks/label-realtime.ts` |
| `label.changed.v1` | `server/tasks/label-signal.server.ts` | `features/tasks/label-realtime.ts` |
| `task.changed.v1` | `server/conversations/conversation-realtime.server.ts` | `features/tasks/task-overview-collection.ts`, `features/tasks/conversation-task-subset.ts`, `features/tasks/use-finished-tasks.ts`, `features/tasks/task-realtime.ts`, `features/tasks/use-task-overview.ts`, `features/tasks/use-conversation-tasks.ts`, `features/tasks/conversation-tasks-collection.ts`, `features/conversations/use-conversation-data.ts` |
| `workspace.deleted.v1` | `server/workspaces/deletion.server.ts` | `features/workspaces/workspace-realtime.ts`, `features/workspaces/leave-deleted-workspace.tsx` |
| `workspace.features.changed.v1` | `server/experiments/features-signal.server.ts` | `features/settings/experiments-settings.tsx`, `features/workspaces/workspace-realtime.ts`, `features/conversations/use-drafts-on.ts` |

## Status and presence channels

These are not versioned events: they carry a status or presence payload on a dedicated channel.

| Channel | Publisher | Receivers |
| --- | --- | --- |
| `agentstatus:<workspaceId>` | `server/agents/agent-visibility-realtime.server.ts` | public Agent status in `features/agents/agent-status-channel.ts` |
| `agentstatus:<workspaceId>:<agentId>` | `server/agents/agent-visibility-realtime.server.ts` | a private Agent's status in `features/agents/agent-status-channel.ts` |
| `agent:activity:<workspaceId>` | `server/agents/agent-activity*.server.ts` | Agent Activity pages |
| `presence:workspace:<workspaceId>` | `server/centrifugo/` presence observer | Workspace presence lists |
