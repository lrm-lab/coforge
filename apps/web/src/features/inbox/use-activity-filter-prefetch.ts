import { useCallback } from "react";
import { useRouter } from "@tanstack/react-router";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import type { ActivityInboxFilter } from "./activity-inbox.schemas";

export function useActivityFilterPrefetch(filter: ActivityInboxFilter) {
  const workspaceSlug = useWorkspaceSlug();
  const router = useRouter();
  return useCallback(
    (next: ActivityInboxFilter) => {
      if (next === filter) return;
      void router.preloadRoute({
        to: "/w/$workspaceSlug/activity",
        params: { workspaceSlug },
        search: (previous) => ({
          ...previous,
          filter: next === "all" ? undefined : next,
        }),
      });
    },
    [filter, router, workspaceSlug],
  );
}
