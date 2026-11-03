export type ConversationRowMenuItemId = "mark-unread" | "pin" | "mute" | "notify" | "close-chat";

export type ConversationRowMenuItem = {
  id: ConversationRowMenuItemId;
  /** The row's current pin state, so the pin item can read "Pin" or "Unpin". */
  pinned: boolean;
  /** The row's current mute state, so the mute item can read "Mute" or "Unmute". */
  muted: boolean;
};

/**
 * Whether a directory row offers the right-click menu (#126). Only an active member's row: the
 * P2b mutations guard membership server-side, so an unjoined row offering them could only ever
 * fail with ACCESS_DENIED.
 */
export function conversationRowMenuEnabled(channel: { joined: boolean }): boolean {
  return channel.joined;
}

/**
 * The menu's items in the mockup's order (#122): Mark as Unread, Pin and Mute as the everyday
 * actions, Close Chat last behind a separator (the separator is presentation, drawn before the last item).
 * "Move to section" left the plan with its schema field. A channel offers its four notification
 * levels in a submenu where a DM offers Mute (task #401): a DM has only on and off.
 */
export function conversationRowMenuItems(row: {
  kind?: "channel" | "direct";
  pinned: boolean;
  muted: boolean;
}): readonly ConversationRowMenuItem[] {
  return [
    { id: "mark-unread", pinned: false, muted: false },
    { id: "pin", pinned: row.pinned, muted: false },
    { id: row.kind === "channel" ? "notify" : "mute", pinned: false, muted: row.muted },
    { id: "close-chat", pinned: false, muted: false },
  ];
}
