import { useQuery } from "@tanstack/react-query";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { channelNamesQuery } from "./conversation-queries";

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
  return useQuery({
    ...channelNamesQuery(workspaceId),
    select: (read) =>
      read.names.find((candidate) =>
        "id" in channel ? candidate.id === channel.id : candidate.name === channel.name,
      ),
    enabled: workspaceId !== "",
  }).data;
}
