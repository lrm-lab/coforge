import type { DirectorySectionId } from "./directory-sections";

/** One row of the sidebar's Pinned section: a pinned channel or a pinned DM, keyed by its
 * conversation id. */
export type PinnedConversation<Channel, Direct> =
  | { kind: "channel"; id: string; channel: Channel }
  | { kind: "direct"; id: string; direct: Direct };

/**
 * Splits the sidebar's rows into the Pinned section and the rest. A member's pins share one order
 * across channels and DMs (the server appends each new pin after the others), so the Pinned
 * section merges both kinds by it; a pinned row appears there and nowhere else, even after the
 * member closes the chat (closing only takes a row out of its own section). Equal orders (pins
 * from before the order was shared) keep channels first, each kind in its own list's order.
 */
export function splitPinnedConversations<
  Channel extends { id: string; pinned: boolean; pinSortOrder: number | null },
  Direct extends {
    conversationId: string;
    pinned: boolean;
    pinSortOrder: number | null;
    hidden: boolean;
  },
>(channels: readonly Channel[], directs: readonly Direct[]) {
  const pinned = [
    ...channels
      .filter((channel) => channel.pinned)
      .map((channel) => ({
        order: channel.pinSortOrder ?? 0,
        entry: { kind: "channel", id: channel.id, channel } as const,
      })),
    ...directs
      .filter((direct) => direct.pinned)
      .map((direct) => ({
        order: direct.pinSortOrder ?? 0,
        entry: { kind: "direct", id: direct.conversationId, direct } as const,
      })),
  ]
    .sort((left, right) => left.order - right.order)
    .map(({ entry }): PinnedConversation<Channel, Direct> => entry);
  return {
    pinned,
    channels: channels.filter((channel) => !channel.pinned),
    directs: directs.filter((direct) => !direct.pinned && !direct.hidden),
  };
}

/** Row keys per section, in display order: `channel:<channelId>` or `direct:<conversationId>`. */
export type DirectoryLayout = Record<DirectorySectionId, string[]>;

/** The section a row lives in when it is not pinned. */
export type HomeSection = "channels" | "agents";

export function channelRowKey(channelId: string) {
  return `channel:${channelId}`;
}
export function directRowKey(conversationId: string) {
  return `direct:${conversationId}`;
}

/** A sidebar row as the member's pins name it: a channel or a DM, each by its id. */
export type PinRef = ReturnType<typeof pinOfRowKey>;

/** The row key for a pin, the reverse of `pinOfRowKey`. */
export function rowKeyOf(ref: PinRef) {
  return ref.kind === "channel" ? channelRowKey(ref.channelId) : directRowKey(ref.conversationId);
}

/** The pin a row key stands for, the shape the server's pin list takes. */
export function pinOfRowKey(key: string) {
  return key.startsWith("channel:")
    ? { kind: "channel" as const, channelId: key.slice("channel:".length) }
    : { kind: "direct" as const, conversationId: key.slice("direct:".length) };
}

function homeSection(key: string): HomeSection {
  return pinOfRowKey(key).kind === "channel" ? "channels" : "agents";
}

/** Pins and custom groups accept either kind; default groups accept their own kind. */
export function canDropInto(key: string, section: DirectorySectionId) {
  return section === "pinned" || section.startsWith("custom:") || section === homeSection(key);
}

/**
 * Previews one row at `index` in pins or a custom group. Default groups restore their natural
 * order and reject the other conversation kind.
 */
export function moveInDirectory(
  layout: DirectoryLayout,
  natural: Record<HomeSection, readonly string[]>,
  key: string,
  to: DirectorySectionId,
  index: number,
): DirectoryLayout {
  if (!canDropInto(key, to) || !layout[to]) return layout;
  const home = homeSection(key);
  const without = { ...layout };
  for (const section of Object.keys(layout) as DirectorySectionId[])
    without[section] = layout[section].filter((entry) => entry !== key);
  if (to === "pinned" || to.startsWith("custom:")) {
    const at = Math.max(0, Math.min(index, without[to].length));
    without[to].splice(at, 0, key);
  } else {
    const present = new Set([...without[home], key]);
    without[home] = natural[home].filter((entry) => present.has(entry));
  }
  // Called on every pointer move of a drag: a move that changes nothing keeps the same object, so
  // the sidebar does not re-render for it.
  return sameLayout(layout, without) ? layout : without;
}

/** The one conversation placement a drag changed. Pins retain their independent public seam. */
export function sectionChangeAfterDrag(
  before: DirectoryLayout,
  after: DirectoryLayout,
  key: string,
) {
  const destination = (Object.keys(after) as DirectorySectionId[]).find((section) =>
    after[section].includes(key),
  );
  if (!destination || destination === "pinned") return null;
  const origin = (Object.keys(before) as DirectorySectionId[]).find((section) =>
    before[section].includes(key),
  );
  if (origin === destination && sameKeys(before[destination], after[destination])) return null;
  const nextKey = after[destination][after[destination].indexOf(key) + 1];
  const next = nextKey ? pinOfRowKey(nextKey) : null;
  return {
    target: pinOfRowKey(key),
    sectionId: destination.startsWith("custom:") ? destination.slice("custom:".length) : null,
    beforeConversationId: next
      ? next.kind === "channel"
        ? next.channelId
        : next.conversationId
      : null,
  };
}

function sameKeys(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((key, index) => right[index] === key);
}

/** Whether two layouts put every row in the same place. */
function sameLayout(left: DirectoryLayout, right: DirectoryLayout) {
  return (Object.keys(left) as DirectorySectionId[]).every((section) =>
    sameKeys(left[section], right[section]),
  );
}

/** What a drag changed about the member's pins: the Pinned rows in their new order and the rows
 * dragged out of Pinned. `null` when the drag left the pins as they were. */
export function pinsAfterDrag(before: DirectoryLayout, after: DirectoryLayout) {
  if (sameKeys(before.pinned, after.pinned)) return null;
  return {
    pins: after.pinned.map(pinOfRowKey),
    unpinned: before.pinned.filter((key) => !after.pinned.includes(key)).map(pinOfRowKey),
  };
}

/** What a dragged row is over: a row (by key) or a list's own space, and in which section. */
export type DropOver = { key: string; section: DirectorySectionId; type: "row" | "section" };

/**
 * Where the dragged row `active` goes for what it is over, or `null` to leave the layout as it is.
 * Over a row, it goes above or below that row by which half of it the dragged row's centre is in
 * (`centres` are vertical positions); over a list's own space (between rows, an empty list) it
 * joins at the end, unless it is already in that list.
 */
export function dropTarget(
  layout: DirectoryLayout,
  active: string,
  over: DropOver,
  centres: { dragged: number; over: number } | null,
) {
  if (over.key === active) return null;
  const list = layout[over.section];
  if (over.type === "section")
    return list.includes(active) ? null : { section: over.section, index: list.length };
  const siblings = list.filter((key) => key !== active);
  const below = centres !== null && centres.dragged > centres.over;
  return { section: over.section, index: siblings.indexOf(over.key) + (below ? 1 : 0) };
}
