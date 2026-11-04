import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { dismissWhatsNew, loadWhatsNew } from "./whats-new.functions";
import { isWhatsNewId, type WhatsNewId } from "./whats-new-entries";

type WhatsNewRead = { ids: string[]; recent: string[] };

const whatsNewQuery = (workspaceId: string | undefined) =>
  queryOptions({
    queryKey: ["whats-new", workspaceId],
    queryFn: (): Promise<WhatsNewRead> => loadWhatsNew(),
    staleTime: 5 * 60_000,
    enabled: workspaceId !== undefined,
  });

/**
 * The entries still to show, oldest first, the latest released ones for when none are, and the
 * dismissal that marks some seen. Ids this build does not know (the server is newer) are left out.
 */
export function useWhatsNew() {
  const workspaceId = useCurrentWorkspaceId();
  const queryClient = useQueryClient();
  const data = useQuery(whatsNewQuery(workspaceId)).data;
  const key = whatsNewQuery(workspaceId).queryKey;
  const dismiss = (ids: readonly string[]) => {
    if (ids.length === 0) return;
    // The dot goes at once; the save follows, and a failed one brings the entries back.
    queryClient.setQueryData<WhatsNewRead>(
      key,
      (current) =>
        current && { ...current, ids: current.ids.filter((each) => !ids.includes(each)) },
    );
    dismissWhatsNew({ data: { ids: [...ids] } }).catch(() =>
      queryClient.invalidateQueries({ queryKey: key }),
    );
  };
  const pending: WhatsNewId[] = (data?.ids ?? []).filter(isWhatsNewId);
  const recent: WhatsNewId[] = (data?.recent ?? []).filter(isWhatsNewId);
  return { pending, recent, dismiss };
}
