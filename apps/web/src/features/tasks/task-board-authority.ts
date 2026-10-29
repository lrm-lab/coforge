import { queryOptions, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { loadTaskBoardAuthority } from "./tasks.functions";

/** The viewer's board-wide Task permission, per Workspace: it changes only with their Workspace
 * role, so the board reads it once and offers exactly the status moves the server accepts. */
export const taskBoardAuthorityQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ["task-board-authority", workspaceId] as const,
    queryFn: () => loadTaskBoardAuthority(),
    staleTime: 5 * 60_000,
  });

/** Whether the viewer sets any Task status (a Workspace owner or admin). False while unknown, so
 * the board never offers a move before it knows the server would accept it. */
export function useCanSetAnyTaskStatus(): boolean {
  const workspaceId = useCurrentWorkspaceId();
  const load = useServerFn(loadTaskBoardAuthority);
  const query = useQuery({
    ...taskBoardAuthorityQuery(workspaceId ?? ""),
    queryFn: () => load(),
    enabled: Boolean(workspaceId),
  });
  return query.data?.canSetAnyStatus ?? false;
}
