import { useMemo } from "react";
import { getRouteApi, useMatch, useRouter } from "@tanstack/react-router";

const RECORDS_ROUTE_ID = getRouteApi("/w/$workspaceSlug/records").id;

/** The Records pages: the catalog the sidebar lists and every page under it, not the Workspace
 * layout around them. */
export function isRecordsMatch(match: { routeId: string }): boolean {
  return match.routeId === RECORDS_ROUTE_ID || match.routeId.startsWith(`${RECORDS_ROUTE_ID}/`);
}

/**
 * The catalog route's `shouldReload`: read on entering Records and whenever a change invalidates
 * it, never just because the page under it reloads. A reload of the same address (any
 * `router.invalidate`, however filtered) otherwise reads again every route whose data is older than
 * its `staleTime`, 0 there, and the catalog is the largest read in the app (task #366).
 */
export function catalogShouldReload({ cause }: { cause: "preload" | "enter" | "stay" }) {
  return cause === "stay" ? false : undefined;
}

/**
 * Reloads what a change on a record's page touched, and nothing else:
 * - `record()`: the record alone, through the route match that shows it (its own page, or the
 *   Records landing that opens on the latest week);
 * - `records()`: the Records pages, for a change the sidebar shows too (a title, a status).
 * Neither reloads the Workspace layout. The catalog reloads only when invalidated or entered
 * (`catalogShouldReload`), so `record()` leaves it alone.
 */
export function useRecordRefresh() {
  const router = useRouter();
  const matchId = useMatch({ strict: false, select: (match) => match.id });
  return useMemo(
    () => ({
      record: () => router.invalidate({ filter: (match) => match.id === matchId }),
      records: () => router.invalidate({ filter: isRecordsMatch }),
    }),
    [router, matchId],
  );
}
