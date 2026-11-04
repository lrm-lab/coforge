import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { workspaceConversationChannel } from "#src/features/conversations/conversation-realtime";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { decodeLabelChangedEvent, decodeLabelGroupChangedEvent } from "./label-realtime";
import { loadWorkspaceLabels } from "./labels.functions";

type WorkspaceLabels = Awaited<ReturnType<typeof loadWorkspaceLabels>>;

/** The query key of the Workspace's labels, read by every picker and refreshed by their events. */
export const workspaceLabelsKey = (workspaceId: string) => ["workspace-labels", workspaceId];

/**
 * The Workspace's labels for a picker, read once and kept fresh by `label.changed.v1` (and
 * `label.group.changed.v1`, which can rename what a label is listed under), and whether the viewer
 * may recolor and delete them.
 */
export function useWorkspaceLabels(enabled: boolean) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const load = useServerFn(loadWorkspaceLabels);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: workspaceLabelsKey(workspaceId),
    queryFn: () => load(),
    enabled: enabled && workspaceId !== "",
    staleTime: 60_000,
  });
  const onPublication = useCallback(
    ({ data }: { data: unknown }) => {
      if (decodeLabelChangedEvent(data) || decodeLabelGroupChangedEvent(data))
        void queryClient.invalidateQueries({ queryKey: workspaceLabelsKey(workspaceId) });
    },
    [queryClient, workspaceId],
  );
  useRealtimeSubscription({
    channel: enabled && workspaceId ? workspaceConversationChannel(workspaceId) : undefined,
    onPublication,
  });
  return {
    labels: query.data?.labels ?? [],
    canManage: query.data?.canManage ?? false,
    workspaceId,
  };
}

/**
 * A label as the Workspace's labels now have it, read from the cache without fetching: a chip
 * follows a recolor, or an archive, without its Task being read again. Without the query's data (a
 * card on a page that never opened a picker) it is the color the Task came with.
 */
export function useCachedLabel(label: { id: string; color: string }) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const cached = useQuery<WorkspaceLabels, Error, { color: string; archived: boolean } | null>({
    queryKey: workspaceLabelsKey(workspaceId),
    enabled: false,
    select: (data) => {
      const found = data.labels.find((each) => each.id === label.id);
      return found ? { color: found.color, archived: found.archivedAt != null } : null;
    },
  });
  return cached.data ?? { color: label.color, archived: false };
}

export type { WorkspaceLabels };
