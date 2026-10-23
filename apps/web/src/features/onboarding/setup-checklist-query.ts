import { queryOptions } from "@tanstack/react-query";
import { loadSetupChecklist } from "./setup-checklist.functions";

/** The viewer's setup steps. While any is left, they are read again every half minute in a visible
 * tab and on returning to the window, and the card asks again on every page change, so a step
 * done here or in another tab ticks off soon after; once every step is done there is nothing left
 * to learn. Not kept in the browser copy of the cache: a stale checklist would be worse than
 * none. */
export const setupChecklistQuery = (workspaceId: string, userId: string) =>
  queryOptions({
    queryKey: ["setup-checklist", workspaceId, userId],
    queryFn: () => loadSetupChecklist(),
    staleTime: 0,
    refetchOnWindowFocus: (query) => !allDone(query.state.data),
    refetchInterval: (query) => (allDone(query.state.data) ? false : 30_000),
  });

function allDone(checklist: { steps: { done: boolean }[] } | undefined) {
  return checklist?.steps.every((step) => step.done) ?? false;
}
