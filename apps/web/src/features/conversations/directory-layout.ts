import { useMemo, useState } from "react";

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

type RecentInput = {
  channels: readonly Pick<DirectoryChannel, "id" | "pinned" | "joined">[];
  directRows: readonly Pick<ListedDirect, "conversationId" | "pinned" | "hidden">[];
  sections: readonly Pick<ChatSection, "sortMode" | "conversationIds">[];
  builtInSortModes?: BuiltInSectionSortModes;
  joinedChannelsOnly?: boolean;
};

export type DirectoryKeyLayout = {
  base: DirectoryLayout;
  natural: {
    channels: string[];
    agents: string[];
  };
};

export function recentConversationIds({
  channels,
  directRows,
  sections,
  builtInSortModes = DEFAULT_BUILT_IN_SORT_MODES,
  joinedChannelsOnly = false,
}: RecentInput): string[] {
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

export function recentConversationIdsByKind({
  channels,
  directRows,
  sections,
  builtInSortModes = DEFAULT_BUILT_IN_SORT_MODES,
  joinedChannelsOnly = false,
}: RecentInput): { channelIds: string[]; directIds: string[] } {
  const channelIds = new Set<string>();
  const directIds = new Set<string>();
  const knownChannels = new Set(channels.map((channel) => channel.id));
  const knownDirects = new Set(directRows.map((direct) => direct.conversationId));
  for (const section of sections) {
    if (section.sortMode === "recent") {
      for (const id of section.conversationIds) {
        if (knownChannels.has(id)) channelIds.add(id);
        else if (knownDirects.has(id)) directIds.add(id);
      }
    }
  }
  if (builtInSortModes.pinned === "recent") {
    for (const channel of channels) if (channel.pinned) channelIds.add(channel.id);
    for (const direct of directRows) if (direct.pinned) directIds.add(direct.conversationId);
  }
  if (builtInSortModes.channels === "recent") {
    for (const channel of channels) {
      if (!joinedChannelsOnly || channel.joined) channelIds.add(channel.id);
    }
  }
  if (builtInSortModes.agents === "recent") {
    for (const direct of directRows) {
      if (direct.pinned || !direct.hidden) directIds.add(direct.conversationId);
    }
  }
  return { channelIds: [...channelIds], directIds: [...directIds] };
}

function stringArraysEqual(left: readonly string[] | undefined, right: readonly string[]): boolean {
  if (!left || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function retainDirectoryLayout(
  previous: DirectoryKeyLayout | undefined,
  next: DirectoryKeyLayout,
): DirectoryKeyLayout {
  if (!previous) return next;
  const naturalChannels = stringArraysEqual(previous.natural.channels, next.natural.channels)
    ? previous.natural.channels
    : next.natural.channels;
  const naturalAgents = stringArraysEqual(previous.natural.agents, next.natural.agents)
    ? previous.natural.agents
    : next.natural.agents;
  const natural =
    naturalChannels === previous.natural.channels && naturalAgents === previous.natural.agents
      ? previous.natural
      : { channels: naturalChannels, agents: naturalAgents };

  const prevKeys = Object.keys(previous.base);
  const nextKeys = Object.keys(next.base);
  let baseUnchanged = prevKeys.length === nextKeys.length;
  const pinned = stringArraysEqual(previous.base.pinned, next.base.pinned)
    ? previous.base.pinned
    : next.base.pinned;
  const channels = stringArraysEqual(previous.base.channels, next.base.channels)
    ? previous.base.channels
    : next.base.channels;
  const agents = stringArraysEqual(previous.base.agents, next.base.agents)
    ? previous.base.agents
    : next.base.agents;
  const retainedBase: DirectoryLayout = { pinned, channels, agents };
  if (
    pinned !== previous.base.pinned ||
    channels !== previous.base.channels ||
    agents !== previous.base.agents
  ) {
    baseUnchanged = false;
  }
  for (const key of nextKeys) {
    if (key === "pinned" || key === "channels" || key === "agents") continue;
    const sectionKey = key as `custom:${string}`;
    const nextList = next.base[sectionKey];
    if (!nextList) continue;
    const prevList = previous.base[sectionKey];
    const kept = stringArraysEqual(prevList, nextList) ? prevList! : nextList;
    retainedBase[sectionKey] = kept;
    if (kept !== prevList) baseUnchanged = false;
  }
  const base = baseUnchanged ? previous.base : retainedBase;
  if (base === previous.base && natural === previous.natural) return previous;
  return { base, natural };
}

function buildDirectoryKeyLayout({
  sortedChannels,
  directRows,
  sections,
  builtInSortModes,
  joinedChannelsOnly,
  lastMessageTimes,
  locale,
}: {
  sortedChannels: readonly DirectoryChannel[];
  directRows: readonly DirectEntry[];
  sections: readonly ChatSection[];
  builtInSortModes: BuiltInSectionSortModes;
  joinedChannelsOnly: boolean;
  lastMessageTimes: ReadonlyMap<string, string | null>;
  locale?: string;
}): DirectoryKeyLayout {
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
  return { base, natural };
}

export function useDirectoryLayout(input: LayoutInput) {
  const {
    channels,
    agents,
    directRows: directRowList,
    viewerId,
    sections,
    builtInSortModes = DEFAULT_BUILT_IN_SORT_MODES,
    joinedChannelsOnly = false,
  } = input;
  const recentIds = useMemo(
    () =>
      recentConversationIdsByKind({
        channels,
        directRows: directRowList,
        sections,
        builtInSortModes,
        joinedChannelsOnly,
      }),
    [channels, directRowList, sections, builtInSortModes, joinedChannelsOnly],
  );
  const lastMessageTimes = useLastMessageTimes(recentIds);
  const sortedChannels = useMemo(
    () =>
      [...channels].sort((left, right) =>
        left.joined === right.joined ? 0 : left.joined ? -1 : 1,
      ),
    [channels],
  );
  const directRows = useMemo(
    () => directEntries(directRowList, agents, viewerId),
    [directRowList, agents, viewerId],
  );
  const locale = getLocale();
  const computed = useMemo(
    () =>
      buildDirectoryKeyLayout({
        sortedChannels,
        directRows,
        sections,
        builtInSortModes,
        joinedChannelsOnly,
        lastMessageTimes,
        locale,
      }),
    [
      sortedChannels,
      directRows,
      sections,
      builtInSortModes,
      joinedChannelsOnly,
      lastMessageTimes,
      locale,
    ],
  );
  const [retained, setRetained] = useState(computed);
  const stable = retainDirectoryLayout(retained, computed);
  if (stable !== retained) setRetained(stable);
  return { sortedChannels, directRows, base: stable.base, natural: stable.natural };
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
  const { base, natural } = buildDirectoryKeyLayout({
    sortedChannels,
    directRows,
    sections,
    builtInSortModes,
    joinedChannelsOnly,
    lastMessageTimes,
    locale,
  });
  return { sortedChannels, directRows, base, natural };
}
