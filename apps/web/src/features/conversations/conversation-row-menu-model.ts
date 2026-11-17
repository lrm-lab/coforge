export type ConversationRowMenuItemId =
  | "mark-read"
  | "mark-unread"
  | "pin"
  | "mute"
  | "notify"
  | "close-chat";

export type ConversationRowMenuItem = {
  id: ConversationRowMenuItemId;
  pinned: boolean;
  muted: boolean;
};

export function conversationRowMenuEnabled(channel: { joined: boolean }): boolean {
  return channel.joined;
}

export function conversationRowMenuItems(row: {
  kind?: "channel" | "direct";
  pinned: boolean;
  muted: boolean;
  hasUnread?: boolean;
}): readonly ConversationRowMenuItem[] {
  return [
    { id: row.hasUnread ? "mark-read" : "mark-unread", pinned: false, muted: false },
    { id: "pin", pinned: row.pinned, muted: false },
    { id: row.kind === "channel" ? "notify" : "mute", pinned: false, muted: row.muted },
    { id: "close-chat", pinned: false, muted: false },
  ];
}
