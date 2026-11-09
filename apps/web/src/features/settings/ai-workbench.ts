import { useQuery, type QueryClient } from "@tanstack/react-query";

import { loadAiWorkbenchOn } from "#src/features/pi-chat/pi-chat.functions";

/** The Workspace's AI Workbench switch. The cache is cleared on a Workspace switch, so the key
 * needs no Workspace id. */
export const AI_WORKBENCH_QUERY_KEY = ["ai-workbench-enabled"] as const;

async function readAiWorkbenchEnabled() {
  return loadAiWorkbenchOn();
}

/** A tab that did not make the change learns of it when its window regains focus. */
export const aiWorkbenchQuery = {
  queryKey: AI_WORKBENCH_QUERY_KEY,
  queryFn: readAiWorkbenchEnabled,
  staleTime: 0,
  refetchOnWindowFocus: "always",
} as const;

/** The switch, seeded from what the page loaded; it is on until the Workspace's owner or an admin turns it off. */
export function useAiWorkbenchEnabled(initial?: boolean) {
  const { data } = useQuery({
    ...aiWorkbenchQuery,
    ...(initial === undefined ? {} : { initialData: initial, initialDataUpdatedAt: Date.now() }),
  });
  return data ?? true;
}

/** The switch as the server has it right now, for a route that must not open while it is off. */
export function fetchAiWorkbenchEnabled(queryClient: QueryClient) {
  return queryClient.fetchQuery(aiWorkbenchQuery);
}

/** Shows the switch as off at once, for a call the server refused because it is off. */
export function markAiWorkbenchOff(queryClient: QueryClient) {
  queryClient.setQueryData(AI_WORKBENCH_QUERY_KEY, false);
}
