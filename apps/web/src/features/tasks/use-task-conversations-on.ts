import { queryOptions, useQuery } from "@tanstack/react-query";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { loadTaskConversationsOn } from "./message-task.functions";

/** Whether the task conversations experiment is on in the Workspace. Read again on a page's next
 * use after a minute, so a switch in Settings shows there. */
export const taskConversationsOnQuery = (workspaceId: string | undefined) =>
  queryOptions({
    queryKey: ["task-conversations-on", workspaceId],
    queryFn: async () => (await loadTaskConversationsOn()).on,
    staleTime: 60_000,
  });

/** Whether task conversations are on here: `true` or `false` once read, `undefined` until then. */
export function useTaskConversationsOn(): boolean | undefined {
  return useQuery(taskConversationsOnQuery(useCurrentWorkspaceId())).data;
}
