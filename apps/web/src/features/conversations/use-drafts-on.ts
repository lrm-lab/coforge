import { useCallback } from "react";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import { decodeWorkspaceFeaturesChangedEvent } from "#src/features/workspaces/workspace-realtime";
import { workspaceConversationChannel } from "./conversation-realtime";
import { loadDraftsOn } from "./drafts.functions";

/** Whether the Drafts experiment is on in the Workspace. The `_chat` route loader reads it ahead,
 * so the sidebar row and the Drafts page have it at first paint. */
export const draftsOnQuery = (workspaceId: string | undefined) =>
  queryOptions({
    queryKey: ["drafts-on", workspaceId],
    queryFn: async () => (await loadDraftsOn()).on,
    staleTime: 60_000,
  });

/**
 * Whether the Drafts experiment is on in this Workspace: `true` or `false` once read, `undefined`
 * until then. A read that failed counts as off. A switch made in Settings arrives as
 * `workspace.features.changed.v1` and is read again.
 */
export function useDraftsOn(): boolean | undefined {
  const workspaceId = useCurrentWorkspaceId();
  const queryClient = useQueryClient();
  const query = draftsOnQuery(workspaceId);
  useRealtimeSubscription({
    channel: workspaceId ? workspaceConversationChannel(workspaceId) : undefined,
    onPublication: useCallback(
      (publication: { data: unknown }) => {
        if (decodeWorkspaceFeaturesChangedEvent(publication.data)?.workspaceId === workspaceId)
          void queryClient.invalidateQueries({ queryKey: draftsOnQuery(workspaceId).queryKey });
      },
      [queryClient, workspaceId],
    ),
  });
  const { data, isError } = useQuery(query);
  return data ?? (isError ? false : undefined);
}
