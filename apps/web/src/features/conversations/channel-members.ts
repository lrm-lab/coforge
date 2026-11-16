import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { channelNamesQuery } from "./conversation-queries";
import type { ChatListValue } from "./chat-lists-reader";

/**
 * A channel's group-avatar members, by id or by name, from the channel names every page already
 * holds (task #74): no read of its own. Undefined for a DM, or a channel not listed to the viewer.
 */
export function useChannelMembers(channel: { id: string } | { name: string }) {
  return useChannelName(channel)?.members;
}

/** A channel's entry in the channel names (its name, visibility and group avatar), by id or by
 * name, from the same read as `useChannelMembers`. */
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
