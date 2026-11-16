import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { channelNamesQuery } from "./conversation-queries";
import type { ChatListValue } from "./chat-lists-reader";

export function useChannelMembers(channel: { id: string } | { name: string }) {
  return useChannelName(channel)?.members;
}

export function useChannelName(channel: { id: string } | { name: string }) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const byId = "id" in channel;
  const key = byId ? channel.id : channel.name;
  const select = useCallback(
    (read: ChatListValue<"channelNames">) =>
      read.names.find((candidate) => (byId ? candidate.id : candidate.name) === key),
    [byId, key],
  );
  return useQuery({
    ...channelNamesQuery(workspaceId),
    select,
    enabled: workspaceId !== "",
  }).data;
}
