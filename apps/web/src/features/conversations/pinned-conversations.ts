import type { DirectorySectionId } from "./directory-sections";

export type PinnedConversation<Channel, Direct> =
  | { kind: "channel"; id: string; channel: Channel }
  | { kind: "direct"; id: string; direct: Direct };

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

export type DirectoryLayout = Record<DirectorySectionId, string[]>;

export type HomeSection = "channels" | "agents";

export function channelRowKey(channelId: string) {
  return `channel:${channelId}`;
}
export function directRowKey(conversationId: string) {
  return `direct:${conversationId}`;
}

export type PinRef = ReturnType<typeof pinOfRowKey>;

export function rowKeyOf(ref: PinRef) {
  return ref.kind === "channel" ? channelRowKey(ref.channelId) : directRowKey(ref.conversationId);
}

export function pinOfRowKey(key: string) {
  return key.startsWith("channel:")
    ? { kind: "channel" as const, channelId: key.slice("channel:".length) }
    : { kind: "direct" as const, conversationId: key.slice("direct:".length) };
}

function homeSection(key: string): HomeSection {
  return pinOfRowKey(key).kind === "channel" ? "channels" : "agents";
}

export function canDropInto(key: string, section: DirectorySectionId) {
  return section === "pinned" || section.startsWith("custom:") || section === homeSection(key);
}

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
  return sameLayout(layout, without) ? layout : without;
}

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

function sameLayout(left: DirectoryLayout, right: DirectoryLayout) {
  return (Object.keys(left) as DirectorySectionId[]).every((section) =>
    sameKeys(left[section], right[section]),
  );
}

export function pinsAfterDrag(before: DirectoryLayout, after: DirectoryLayout) {
  if (sameKeys(before.pinned, after.pinned)) return null;
  return {
    pins: after.pinned.map(pinOfRowKey),
    unpinned: before.pinned.filter((key) => !after.pinned.includes(key)).map(pinOfRowKey),
  };
}
