import type { ChatListValue } from "./chat-lists-reader";
import type { PreviewCard } from "./action-card-preview";
import type { PreviewNotice } from "./preview-line";

type DirectPreferences = Omit<ChatListValue<"directPreferences">, "streamPositions">;

export type DirectPeer = DirectPreferences["conversations"][number]["peer"];

export type DirectRow = {
  conversationId: string;
  position: number;
  peer: DirectPeer;
  pinned: boolean;
  pinSortOrder: number | null;
  hidden: boolean;
  muted?: boolean;
  markedUnread?: boolean;
  unreadCount: number;
  firstUnreadMessageId?: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageNotice?: PreviewNotice | null;
  lastMessageCard?: PreviewCard | null;
};

export type ListedDirect = Omit<
  DirectRow,
  "lastMessageAt" | "lastMessagePreview" | "lastMessageNotice" | "lastMessageCard"
>;

export function directRowsOf(
  preferences: DirectPreferences,
  unread: Readonly<Record<string, number>>,
  firstUnreadMessageIds?: Readonly<Record<string, string | null>>,
): DirectRow[] {
  const pins = new Map(preferences.pinned.map((pin) => [pin.conversationId, pin.sortOrder]));
  const hidden = new Set(preferences.hidden);
  return preferences.conversations.map(
    ({ conversationId, peer, muted, markedUnread, lastMessage }, position) => ({
      conversationId,
      position,
      peer,
      pinned: pins.has(conversationId),
      pinSortOrder: pins.get(conversationId) ?? null,
      hidden: hidden.has(conversationId),
      muted,
      ...(markedUnread ? { markedUnread: true } : {}),
      unreadCount: unread[conversationId] ?? 0,
      ...(firstUnreadMessageIds?.[conversationId]
        ? { firstUnreadMessageId: firstUnreadMessageIds[conversationId] }
        : {}),
      lastMessageAt: lastMessage?.createdAt ?? null,
      lastMessagePreview: lastMessage?.preview ?? null,
      lastMessageNotice: lastMessage?.notice ?? null,
      lastMessageCard: lastMessage?.card ?? null,
    }),
  );
}

export function directListsOf(unordered: readonly ListedDirect[]) {
  const rows = [...unordered].sort((left, right) => left.position - right.position);
  return {
    rows,
    closedIds: rows.filter((row) => row.hidden && !row.pinned).map((row) => row.conversationId),
    unread: Object.fromEntries(
      rows.filter((row) => row.unreadCount > 0).map((row) => [row.conversationId, row.unreadCount]),
    ),
  };
}

function openDirectRows(lists: ReturnType<typeof directListsOf>): ListedDirect[] {
  const closed = new Set(lists.closedIds);
  return lists.rows.filter((row) => !closed.has(row.conversationId));
}

export function listedDirectIds(
  lists: ReturnType<typeof directListsOf>,
  agents: readonly { id: string }[],
): string[] {
  const live = new Set(agents.map((agent) => agent.id));
  return openDirectRows(lists).flatMap((row) =>
    row.peer.kind === "people" || live.has(row.peer.agentId) ? [row.conversationId] : [],
  );
}

export function listedDirectAgentIds(
  lists: ReturnType<typeof directListsOf>,
): ReadonlyMap<string, string> {
  return new Map(
    openDirectRows(lists).flatMap((row) =>
      row.peer.kind === "agent" ? [[row.peer.agentId, row.conversationId] as const] : [],
    ),
  );
}
