import { useMemo } from "react";

import type { AgentDirectoryEntry } from "#src/features/agents/workspace-agents-realtime";
import { getLocale } from "#src/paraglide/runtime";
import type { ChatSection } from "./chat-section.schemas";
import { sortSectionRows, type SortableRow } from "./chat-section-sort";
import type { DirectEntry, DirectoryChannel } from "./conversation-directory-rows";
import {
  DEFAULT_BUILT_IN_SORT_MODES,
  type BuiltInSectionSortModes,
  type NaturalSectionSortMode,
} from "./directory-sections";
import {
  channelRowKey,
  directRowKey,
  splitPinnedConversations,
  type DirectoryLayout,
} from "./pinned-conversations";
import type { ListedDirect } from "./sidebar-rows";
import { useLastMessageTimes } from "./sidebar-lists";

type LayoutInput = {
  channels: readonly DirectoryChannel[];
  agents: readonly AgentDirectoryEntry[];
  directRows: readonly ListedDirect[];
  viewerId?: string;
  sections: readonly ChatSection[];
  builtInSortModes?: BuiltInSectionSortModes;
  joinedChannelsOnly?: boolean;
};

export function recentConversationIds({
  channels,
  directRows,
  sections,
  builtInSortModes = DEFAULT_BUILT_IN_SORT_MODES,
  joinedChannelsOnly = false,
}: {
  channels: readonly Pick<DirectoryChannel, "id" | "pinned" | "joined">[];
  directRows: readonly Pick<ListedDirect, "conversationId" | "pinned" | "hidden">[];
  sections: readonly Pick<ChatSection, "sortMode" | "conversationIds">[];
  builtInSortModes?: BuiltInSectionSortModes;
  joinedChannelsOnly?: boolean;
}): string[] {
  const ids = new Set<string>();
  for (const section of sections) {
    if (section.sortMode === "recent") {
      for (const id of section.conversationIds) ids.add(id);
    }
  }
  if (builtInSortModes.pinned === "recent") {
    for (const channel of channels) if (channel.pinned) ids.add(channel.id);
    for (const direct of directRows) if (direct.pinned) ids.add(direct.conversationId);
  }
  if (builtInSortModes.channels === "recent") {
    for (const channel of channels) {
      if (!joinedChannelsOnly || channel.joined) ids.add(channel.id);
    }
  }
  if (builtInSortModes.agents === "recent") {
    for (const direct of directRows) {
      if (direct.pinned || !direct.hidden) ids.add(direct.conversationId);
    }
  }
  return [...ids];
}

export function useDirectoryLayout(input: LayoutInput) {
  const {
    channels,
    agents,
    directRows,
    viewerId,
    sections,
    builtInSortModes = DEFAULT_BUILT_IN_SORT_MODES,
    joinedChannelsOnly = false,
  } = input;
  const recentIds = useMemo(
    () =>
      recentConversationIds({
        channels,
        directRows,
        sections,
        builtInSortModes,
        joinedChannelsOnly,
      }),
    [channels, directRows, sections, builtInSortModes, joinedChannelsOnly],
  );
  const lastMessageTimes = useLastMessageTimes(recentIds);
  return useMemo(
    () =>
      directoryLayout({
        channels,
        agents,
        directRows,
        viewerId,
        sections,
        builtInSortModes,
        joinedChannelsOnly,
        lastMessageTimes,
        locale: getLocale(),
      }),
    [
      channels,
      agents,
      directRows,
      viewerId,
      sections,
      builtInSortModes,
      joinedChannelsOnly,
      lastMessageTimes,
    ],
  );
}

export function directEntries(
  directRows: readonly ListedDirect[],
  agents: readonly AgentDirectoryEntry[],
  viewerId?: string,
): DirectEntry[] {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  return directRows.flatMap((row): DirectEntry[] => {
    if (row.peer.kind === "people")
      return [{ ...row, name: row.peer.displayName, self: row.peer.userId === viewerId }];
    const agent = agentsById.get(row.peer.agentId);
    return agent ? [{ ...row, name: agent.displayName, agent, self: false }] : [];
  });
}

function sortChannelGroup(
  channels: readonly DirectoryChannel[],
  mode: NaturalSectionSortMode,
  lastMessageTimes: ReadonlyMap<string, string | null>,
  locale?: string,
): string[] {
  const toSortable = (list: readonly DirectoryChannel[]): SortableRow[] =>
    list.map((channel) => ({
      key: channelRowKey(channel.id),
      name: channel.name,
      lastMessageAt: lastMessageTimes.get(channel.id) ?? null,
    }));
  const joined = channels.filter((channel) => channel.joined);
  const unjoined = channels.filter((channel) => !channel.joined);
  return [
    ...sortSectionRows(toSortable(joined), mode, locale),
    ...sortSectionRows(toSortable(unjoined), mode, locale),
  ];
}

function sortDirectGroup(
  directs: readonly DirectEntry[],
  mode: NaturalSectionSortMode,
  lastMessageTimes: ReadonlyMap<string, string | null>,
  locale?: string,
): string[] {
  const rows: SortableRow[] = directs.map((direct) => ({
    key: directRowKey(direct.conversationId),
    name: direct.name,
    lastMessageAt: lastMessageTimes.get(direct.conversationId) ?? null,
  }));
  return sortSectionRows(rows, mode, locale);
}

export function directoryLayout({
  channels,
  agents,
  directRows: directRowList,
  viewerId,
  sections,
  builtInSortModes = DEFAULT_BUILT_IN_SORT_MODES,
  joinedChannelsOnly = false,
  lastMessageTimes,
  locale,
}: LayoutInput & {
  lastMessageTimes: ReadonlyMap<string, string | null>;
  locale?: string;
}) {
  const sortedChannels = [...channels].sort((left, right) =>
    left.joined === right.joined ? 0 : left.joined ? -1 : 1,
  );
  const directRows = directEntries(directRowList, agents, viewerId);
  const split = splitPinnedConversations(sortedChannels, directRows);
  const pinnedRows: SortableRow[] = split.pinned.map((entry) =>
    entry.kind === "channel"
      ? {
          key: channelRowKey(entry.id),
          name: entry.channel.name,
          lastMessageAt: lastMessageTimes.get(entry.id) ?? null,
        }
      : {
          key: directRowKey(entry.id),
          name: entry.direct.name,
          lastMessageAt: lastMessageTimes.get(entry.id) ?? null,
        },
  );
  const pinnedKeys = new Set(pinnedRows.map((row) => row.key));
  const listedChannels = joinedChannelsOnly
    ? sortedChannels.filter((channel) => channel.joined)
    : sortedChannels;
  const natural = {
    channels: sortChannelGroup(listedChannels, builtInSortModes.channels, lastMessageTimes, locale),
    agents: sortDirectGroup(
      directRows.filter((direct) => direct.pinned || !direct.hidden),
      builtInSortModes.agents,
      lastMessageTimes,
      locale,
    ),
  };
  const base: DirectoryLayout = {
    pinned: sortSectionRows(pinnedRows, builtInSortModes.pinned, locale),
    channels: natural.channels.filter((key) => !pinnedKeys.has(key)),
    agents: natural.agents.filter((key) => !pinnedKeys.has(key)),
  };
  const available = new Set([...base.channels, ...base.agents]);
  const sortable = new Map<string, SortableRow>();
  for (const channel of sortedChannels) {
    const key = channelRowKey(channel.id);
    const lastMessageAt = lastMessageTimes.get(channel.id) ?? null;
    if (available.has(key)) sortable.set(channel.id, { key, name: channel.name, lastMessageAt });
  }
  for (const direct of directRows) {
    const key = directRowKey(direct.conversationId);
    const { name } = direct;
    const lastMessageAt = lastMessageTimes.get(direct.conversationId) ?? null;
    if (available.has(key)) sortable.set(direct.conversationId, { key, name, lastMessageAt });
  }
  for (const section of sections) {
    const rows = section.conversationIds.flatMap((id) => sortable.get(id) ?? []);
    const keys = sortSectionRows(rows, section.sortMode, locale);
    base[`custom:${section.id}`] = keys;
    const grouped = new Set(keys);
    base.channels = base.channels.filter((key) => !grouped.has(key));
    base.agents = base.agents.filter((key) => !grouped.has(key));
  }
  return { sortedChannels, directRows, base, natural };
}
