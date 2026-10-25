import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { loadTaskAssignmentAccess } from "./tasks.functions";

const appRoute = getRouteApi("/w/$workspaceSlug");

/** UI choices use the same current role predicate as the write boundary. */
export function useTaskAssignmentAccess() {
  const workspaceId = useCurrentWorkspaceId();
  const userId = appRoute.useLoaderData({ select: (data) => data.user.id });
  const access = useQuery({
    queryKey: ["task", "assignment-access", workspaceId, userId],
    queryFn: () => loadTaskAssignmentAccess(),
    enabled: Boolean(workspaceId),
  });
  return { userId, canAssignOthers: access.data === true, refetch: access.refetch };
}
