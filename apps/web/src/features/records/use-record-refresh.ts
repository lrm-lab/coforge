import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useMatch, useRouter } from "@tanstack/react-router";

import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { recordsNavAttentionQuery } from "./records-nav-attention";

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
 * Reloads what a change in Records touched, and nothing else; each resolves once what it reloads
 * is shown:
 * - `record()`: the record alone, through the route match that shows it (its own page, or the
 *   Records landing that opens on the latest week), for a change only it shows (its body, its key
 *   points);
 * - `records()`: the Records pages and the Records rail dot (`recordsNavAttentionQuery`), for a
 *   change anything else in Records may show (a title, a status, a send, a setting), from a Records
 *   page or from a card elsewhere (a Records page held in the router's cache reads again when shown).
 * Neither reloads the Workspace layout. The catalog reloads only when invalidated or entered
 * (`catalogShouldReload`), so `record()` leaves it alone.
 */
export function useRecordRefresh() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const workspaceSlug = useWorkspaceSlug();
  const matchId = useMatch({ strict: false, select: (match) => match.id });
  return useMemo(
    () => ({
      record: () => router.invalidate({ filter: (match) => match.id === matchId, sync: true }),
      records: () =>
        Promise.all([
          router.invalidate({ filter: isRecordsMatch, sync: true }),
          queryClient.invalidateQueries({
            queryKey: recordsNavAttentionQuery(workspaceSlug).queryKey,
          }),
        ]),
    }),
    [router, queryClient, workspaceSlug, matchId],
  );
}
