import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { loadWorkspaceDirectory } from "#src/features/workspaces/workspaces.functions";

/** The Workspace's Agents and people, one cached read for every Chat picker that lists them. */
export function useWorkspaceDirectory({ enabled = true }: { enabled?: boolean } = {}) {
  const workspaceId = useCurrentWorkspaceId();
  const load = useServerFn(loadWorkspaceDirectory);
  return useQuery({
    queryKey: ["direct-message-directory", workspaceId],
    queryFn: () => load(),
    enabled: enabled && !!workspaceId,
  });
}
