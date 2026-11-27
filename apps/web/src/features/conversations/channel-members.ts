import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { channelNamesQuery } from "./conversation-queries";
import type { ChatListValue } from "./chat-lists-reader";

export type ChannelNameEntry = ChatListValue<"channelNames">["names"][number];

export type ChannelNamesIndex = {
  byId: ReadonlyMap<string, ChannelNameEntry>;
  byName: ReadonlyMap<string, ChannelNameEntry>;
};

const EMPTY_CHANNEL_NAMES_INDEX: ChannelNamesIndex = {
  byId: new Map(),
  byName: new Map(),
};

const channelIndexCache = new WeakMap<readonly ChannelNameEntry[], ChannelNamesIndex>();

export function indexChannelNames(
  names: readonly ChannelNameEntry[] | undefined,
): ChannelNamesIndex {
  if (!names || names.length === 0) return EMPTY_CHANNEL_NAMES_INDEX;
  let index = channelIndexCache.get(names);
  if (!index) {
    const byId = new Map<string, ChannelNameEntry>();
    const byName = new Map<string, ChannelNameEntry>();
    for (const entry of names) {
      byId.set(entry.id, entry);
      if (!byName.has(entry.name)) byName.set(entry.name, entry);
    }
    index = { byId, byName };
    channelIndexCache.set(names, index);
  }
  return index;
}

export function useChannelNamesIndex(): ChannelNamesIndex {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const query = useQuery({
    ...channelNamesQuery(workspaceId),
    enabled: workspaceId !== "",
  });
  return indexChannelNames(query.data);
}

export function useChannelMembers(channel: { id: string } | { name: string }) {
  return useChannelName(channel)?.members;
}

export function useChannelName(channel: { id: string } | { name: string }) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const byId = "id" in channel;
  const key = byId ? channel.id : channel.name;
  const select = useCallback(
    (read: ChatListValue<"channelNames">) => {
      const index = indexChannelNames(read.names);
      return byId ? index.byId.get(key) : index.byName.get(key);
    },
    [byId, key],
  );
  return useQuery({
    ...channelNamesQuery(workspaceId),
    select,
    enabled: workspaceId !== "",
  }).data;
}
