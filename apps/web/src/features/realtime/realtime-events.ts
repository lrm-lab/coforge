/**
 * Every versioned browser realtime event name, in one place. Publishers in
 * `src/server/` and the client's subscription schemas use these constants; the
 * catalog test compares this list with `docs/realtime-events.md`, so adding an
 * event forces both the server and the table to change with it.
 */
export const REALTIME_EVENTS = {
  memberChanged: "member.changed.v1",
  channelUpdated: "channel.updated.v1",
  channelCreated: "channel.created.v1",
  channelJoined: "channel.joined.v1",
  channelLeft: "channel.left.v1",
  channelClosed: "channel.closed.v1",
  channelOpened: "channel.opened.v1",
  channelMarked: "channel.marked.v1",
  dmCreated: "dm.created.v1",
  dmOpened: "dm.opened.v1",
  dmClosed: "dm.closed.v1",
  dmMarked: "dm.marked.v1",
  activityChanged: "activity.changed.v1",
  conversationActivity: "conversation.activity.v1",
  conversationRead: "conversation.read.v1",
  messageAvailable: "message.available.v1",
  messageReaction: "message.reaction.v1",
  notificationAvailable: "notification.available.v1",
  prefChanged: "pref.changed.v1",
  recordChanged: "record.changed.v1",
  savedAdded: "saved.added.v1",
  savedRemoved: "saved.removed.v1",
  taskChanged: "task.changed.v1",
  workspaceDeleted: "workspace.deleted.v1",
  workspaceFeaturesChanged: "workspace.features.changed.v1",
  agentChanged: "agent.changed.v1",
  runtimeAuthLogin: "runtime-auth.login.v1",
  runtimeAuthLogout: "runtime-auth.logout.v1",
  runtimeAuthStatus: "runtime-auth.status.v1",
} as const;

export type RealtimeEvent = (typeof REALTIME_EVENTS)[keyof typeof REALTIME_EVENTS];
