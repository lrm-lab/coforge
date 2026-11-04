import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { dismissWhatsNew, loadWhatsNew } from "./whats-new.functions";

const whatsNewQuery = (workspaceId: string | undefined) =>
  queryOptions({
    queryKey: ["whats-new", workspaceId],
    queryFn: async () => (await loadWhatsNew()).ids,
    staleTime: 5 * 60_000,
    enabled: workspaceId !== undefined,
  });

/** The entry to show now, how many wait behind it, and the dismissal that marks it seen. */
export function useWhatsNew() {
  const workspaceId = useCurrentWorkspaceId();
  const queryClient = useQueryClient();
  const ids = useQuery(whatsNewQuery(workspaceId)).data ?? [];
  const key = whatsNewQuery(workspaceId).queryKey;
  const dismiss = (id: string) => {
    // The next entry shows at once; the save follows, and a failed one shows this entry again.
    queryClient.setQueryData<string[]>(key, (current) => current?.filter((each) => each !== id));
    dismissWhatsNew({ data: { id } }).catch(() => queryClient.invalidateQueries({ queryKey: key }));
  };
  return { current: ids[0], more: Math.max(0, ids.length - 1), dismiss };
}
