import type { ChatListValue } from "./chat-lists-reader";

/** What the server says about the viewer's DMs, by conversation id; the stream positions it was
 * read at (`streamPositions`) belong to the list, not to a row. */
type DirectPreferences = Omit<ChatListValue<"directPreferences">, "streamPositions">;

/** Who a DM is with: the viewer's Agent, or a member (the viewer themself in their own DM). */
export type DirectPeer = DirectPreferences["conversations"][number]["peer"];

/**
 * One DM's row in the Chat sidebar's Direct messages (see `sidebar-lists.ts`), with an Agent or a
 * member alike: who it is with, its pin, whether it is muted or closed, and its unread count. The fields a
 * sidebar change touches are named as on a channel row, so one change reads the same for both.
 */
export type DirectRow = {
  conversationId: string;
  /** Where the server lists it (the order the DMs started): the synced collection hands rows back
   * in its own key order, so the list sorts by this. */
  position: number;
  peer: DirectPeer;
  pinned: boolean;
  pinSortOrder: number | null;
  hidden: boolean;
  /** The viewer muted this DM: its unread count degrades to a dot. Absent from a copy stored
   * before DMs carried it, which reads as audible until the list is read again. */
  muted?: boolean;
  unreadCount: number;
  /** When the DM's last message was sent (ISO), or `null` while the DM has no message yet. */
  lastMessageAt: string | null;
  /** The start of the DM's last message, for the row's second line. `""` when that message's body
   * is empty; `null` only when the DM has no top-level message. */
  lastMessagePreview: string | null;
};

/** One row per DM the preferences list, in their order, with its unread count. */
export function directRowsOf(
  preferences: DirectPreferences,
  unread: Readonly<Record<string, number>>,
): DirectRow[] {
  const pins = new Map(preferences.pinned.map((pin) => [pin.conversationId, pin.sortOrder]));
  const hidden = new Set(preferences.hidden);
  return preferences.conversations.map(
    ({ conversationId, peer, muted, lastMessage }, position) => ({
      conversationId,
      position,
      peer,
      pinned: pins.has(conversationId),
      pinSortOrder: pins.get(conversationId) ?? null,
      hidden: hidden.has(conversationId),
      muted,
      unreadCount: unread[conversationId] ?? 0,
      lastMessageAt: lastMessage?.createdAt ?? null,
      lastMessagePreview: lastMessage?.preview ?? null,
    }),
  );
}

/** The rows as the sidebar reads them: all of them in the server's order, the closed ones (a
 * closed DM that is pinned stays listed, in Pinned), and the unread counts, all by conversation
 * id. */
export function directListsOf(unordered: readonly DirectRow[]) {
  const rows = [...unordered].sort((left, right) => left.position - right.position);
  return {
    rows,
    closedIds: rows.filter((row) => row.hidden && !row.pinned).map((row) => row.conversationId),
    unread: Object.fromEntries(
      rows.filter((row) => row.unreadCount > 0).map((row) => [row.conversationId, row.unreadCount]),
    ),
  };
}

/** The rows the sidebar does not close: the one place a closed DM is told from a listed one. */
function openDirectRows(lists: ReturnType<typeof directListsOf>): DirectRow[] {
  const closed = new Set(lists.closedIds);
  return lists.rows.filter((row) => !closed.has(row.conversationId));
}

/** The direct messages the sidebar lists, by conversation id: each open one with a member, or with
 * an Agent that is still in the Workspace. */
export function listedDirectIds(
  lists: ReturnType<typeof directListsOf>,
  agents: readonly { id: string }[],
): string[] {
  const live = new Set(agents.map((agent) => agent.id));
  return openDirectRows(lists).flatMap((row) =>
    row.peer.kind === "people" || live.has(row.peer.agentId) ? [row.conversationId] : [],
  );
}

/** The Agents the viewer has an open DM with, by Agent id to that DM's conversation id: the DMs the
 * sidebar lists with an Agent (`listedDirectIds`), whether or not the Agent is still there. */
export function listedDirectAgentIds(
  lists: ReturnType<typeof directListsOf>,
): ReadonlyMap<string, string> {
  return new Map(
    openDirectRows(lists).flatMap((row) =>
      row.peer.kind === "agent" ? [[row.peer.agentId, row.conversationId] as const] : [],
    ),
  );
}
