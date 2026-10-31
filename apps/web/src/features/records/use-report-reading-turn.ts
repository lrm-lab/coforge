import { useEffect } from "react";
import { getRouteApi, useNavigate, useRouter } from "@tanstack/react-router";

import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import {
  readingWheelSession,
  sameTemplateNeighbors,
  stageReadingEdge,
  type ReadingEdge,
} from "./weekly-report-reading-turn";

const recordsRoute = getRouteApi("/w/$workspaceSlug/records");

/** Keeps the Records tab and the key-point return path when moving between reports. */
function keepRecordsSearch(previous: { tab?: unknown; returnTo?: unknown }) {
  return {
    tab: previous.tab === "notes" ? ("notes" as const) : ("weekly" as const),
    ...(typeof previous.returnTo === "string" ? { returnTo: previous.returnTo } : {}),
  };
}

/**
 * Lets one wheel gesture at the body edge turn to the previous or next report
 * of the same template. Returns the `readingTurn` prop for `ReportTabsEditor`,
 * or undefined when this reader does not page through reports.
 */
export function useReportReadingTurn(reportId: string, enabled: boolean) {
  const router = useRouter();
  const navigate = useNavigate();
  const workspaceSlug = useWorkspaceSlug();
  const catalog = recordsRoute.useLoaderData();
  const neighbors = enabled
    ? sameTemplateNeighbors(catalog.memberWeeks, reportId)
    : { previousId: null, nextId: null };

  useEffect(() => {
    if (!enabled) return;
    for (const recordId of [neighbors.previousId, neighbors.nextId]) {
      if (!recordId) continue;
      void router.preloadRoute({
        to: "/w/$workspaceSlug/records/$recordId",
        params: { workspaceSlug, recordId },
        search: keepRecordsSearch,
      });
    }
  }, [neighbors.nextId, neighbors.previousId, enabled, router, workspaceSlug]);

  function openNeighbor(recordId: string, edge: ReadingEdge) {
    stageReadingEdge(recordId, edge);
    void navigate({
      to: "/w/$workspaceSlug/records/$recordId",
      params: { workspaceSlug, recordId },
      search: keepRecordsSearch,
      resetScroll: false,
    });
  }

  if (!enabled) return undefined;
  return {
    reportId,
    previousReportId: neighbors.previousId,
    nextReportId: neighbors.nextId,
    wheel: readingWheelSession(),
    onOpenReport: openNeighbor,
  };
}
