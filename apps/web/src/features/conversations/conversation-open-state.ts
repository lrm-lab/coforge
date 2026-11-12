import type { FirstUnread } from "#src/server/conversations/conversation-open.server";

/**
 * Where a conversation or thread pane opens and where its "New messages" divider sits, in three
 * steps (task #378): wait for this open's read of where the viewer's unread starts
 * (`firstUnreadOnOpen`), freeze it, done. The divider comes from that read, never from a
 * window the page may hold from earlier (in memory or the browser's storage), so a held window's
 * messages paint at once while only the divider, the landing and the read cursor wait. An opener
 * that has read where unread starts already (an Activity row, `unreadFrom`) lets the divider and
 * the landing take it at once when the window holds it; the read moves only the divider if it
 * differs, and the read cursor still waits for it (task #102).
 */

/** This open's read, as the pane has it so far. A failed read is retried; until one lands the
 * pane opens at its latest, draws no divider and does not move the read cursor. */
export type OpenRead =
  | { status: "pending" | "error" }
  | { status: "success"; firstUnread: FirstUnread | null };

/** The divider and landing an open froze, or that it still waits. */
export type OpenState =
  | { waiting: true; readAround?: string }
  | { waiting: false; boundary?: FirstUnread; provisional?: true };

/**
 * The open's state once its read is in, for the messages the pane holds (top-level, oldest
 * first). It waits for the read, and then for the window to hold the message the divider goes on:
 * a window held from earlier that ends before it is caught up by the read that follows the open;
 * one that begins after it (the first unread is older than all it holds) is read around it
 * (`readAround`), as a jump is. A window around it that does not hold it (a message not shown)
 * waits no longer: the pane opens at its latest. Before the read, a window holding where the
 * opener read unread starts (`unreadFrom`) opens there at once, `provisional` until the read lands.
 */
export function openState(
  read: OpenRead,
  messages: readonly { id: string; sequence: number }[],
  /** Where the opener read the viewer's unread starts (`HostedConversationTarget.unreadFrom`). */
  unreadFrom?: string,
): OpenState {
  if (read.status !== "success") {
    const known = unreadFrom ? messages.find((message) => message.id === unreadFrom) : undefined;
    return known
      ? { waiting: false, boundary: { id: known.id, sequence: known.sequence }, provisional: true }
      : { waiting: true };
  }
  const boundary = read.firstUnread ?? undefined;
  if (!boundary) return { waiting: false };
  if (messages.some((message) => message.id === boundary.id)) return { waiting: false, boundary };
  if ((messages.at(-1)?.sequence ?? 0) < boundary.sequence) return { waiting: true };
  if (messages[0]!.sequence > boundary.sequence) return { waiting: true, readAround: boundary.id };
  return { waiting: false, boundary };
}
