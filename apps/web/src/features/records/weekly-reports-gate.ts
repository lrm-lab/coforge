import { useQuery, type QueryClient } from "@tanstack/react-query";

import { MEMBER_DIRECTORY_KEY } from "#src/features/agents/member-directory-queries";
import { extraAgentsQueryKey } from "#src/features/agents/workspace-agents-refresh";
import { sidebarDirectsQueryKey } from "#src/features/conversations/conversation-query-keys";
import { loadWeeklyReportsOn } from "./records.functions";

export const WEEKLY_REPORTS_QUERY_KEY = ["weekly-reports-enabled"] as const;

async function readWeeklyReportsEnabled() {
  return loadWeeklyReportsOn();
}

export const weeklyReportsQuery = {
  queryKey: WEEKLY_REPORTS_QUERY_KEY,
  queryFn: readWeeklyReportsEnabled,
  staleTime: 60_000,
  refetchOnWindowFocus: "always",
} as const;

export function useWeeklyReportsEnabled(initial?: boolean) {
  const { data } = useQuery({
    ...weeklyReportsQuery,
    ...(initial === undefined ? {} : { initialData: initial, initialDataUpdatedAt: Date.now() }),
  });
  return data ?? false;
}

export function fetchWeeklyReportsEnabled(queryClient: QueryClient) {
  return queryClient.fetchQuery(weeklyReportsQuery);
}

export function ensureWeeklyReportsEnabled(queryClient: QueryClient) {
  return queryClient.ensureQueryData(weeklyReportsQuery);
}

export function invalidateWeeklyReportsDependents(
  queryClient: QueryClient,
  workspaceId: string | undefined,
) {
  void queryClient.invalidateQueries({ queryKey: MEMBER_DIRECTORY_KEY });
  void queryClient.invalidateQueries({ queryKey: ["records"] });
  if (workspaceId) {
    void queryClient.invalidateQueries({ queryKey: sidebarDirectsQueryKey(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: extraAgentsQueryKey(workspaceId) });
  }
}
