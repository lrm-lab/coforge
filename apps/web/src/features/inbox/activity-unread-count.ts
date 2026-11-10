import type { ConversationActivityEvent } from "#src/features/conversations/conversation-activity-event";

/** The count stops here: 100 means "100 or more", as the server counts it. */
export const ACTIVITY_UNREAD_COUNT_CAP = 100;

/**
 * What the nav Activity badge holds. `unreadCount` and `unreadKeys` come from the server together;
 * an older server sends neither, and the badge is then the dot `hasUnread` lights.
 *
 * `unreadKeys` names the items counted in `unreadCount` (at most 100): `conversation:<id>`,
 * `thread:<rootMessageId>`, `mention:<pendingMentionActionId>` and `comment:<notificationId>`.
 */
export type ActivityUnreadState = {
  hasUnread: boolean;
  unreadCount?: number;
  unreadKeys?: string[];
};

export type ActivityUnreadContext = {
  viewerUserId: string;
  /** The conversation or thread open in front of the viewer right now, as an item key. */
  viewingKey?: string;
};

export type ActivityUnreadMessage = Pick<
  ConversationActivityEvent,
  "conversationId" | "senderUserId" | "sender" | "threadRootId" | "muted"
>;

/**
 * Applies one message to the count, without a read. `reread` says the page cannot tell the
 * count from the message alone and the server should be asked (throttled by the caller);
 * `lights` says the message is one the dot counts, whether or not it changed the state.
 *
 * A reply is published only to its thread's followers, so a reply in a thread the viewer does not
 * follow never arrives, and every message that does arrive counts its own item. An item the viewer
 * marked Done counts again with a newer message (the server lists it once its latest sequence is
 * past the Done), so it is simply a key that is not in the set. The state is returned as it is when
 * nothing changes.
 */
export function applyActivityMessage(
  state: ActivityUnreadState,
  message: ActivityUnreadMessage,
  { viewerUserId, viewingKey }: ActivityUnreadContext,
): { state: ActivityUnreadState; reread: boolean; lights: boolean } {
  const ignored = { state, reread: false, lights: false };
  if (message.senderUserId === viewerUserId || message.sender.kind === "system") return ignored;
  // A muted channel counts only with an unread mention of the viewer, which only the server can
  // tell from the message.
  if (message.muted) return { ...ignored, reread: true };
  const key = message.threadRootId
    ? `thread:${message.threadRootId}`
    : `conversation:${message.conversationId}`;
  if (key === viewingKey) return ignored;
  const { unreadCount, unreadKeys = [] } = state;
  // An older server counts nothing: the dot alone. A key held, or a count at its cap (whose key
  // set may be incomplete), is counted already.
  if (
    unreadCount === undefined ||
    unreadKeys.includes(key) ||
    unreadCount >= ACTIVITY_UNREAD_COUNT_CAP
  )
    return {
      state: state.hasUnread ? state : { ...state, hasUnread: true },
      reread: false,
      lights: true,
    };
  return {
    state: {
      ...state,
      hasUnread: true,
      unreadCount: unreadCount + 1,
      unreadKeys: [...unreadKeys, key],
    },
    reread: false,
    lights: true,
  };
}
