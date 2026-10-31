import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMatch } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { useDebouncedValue } from "#src/lib/use-debounced-value";
import type { RecordsCatalog } from "./records-layout";
import {
  loadMemberWeekAt,
  loadOlderMemberWeeks,
  searchMemberWeeks,
} from "./records-member-weeks.functions";
import { filterMemberWeeks, isSelectedMemberWeek, mergeMemberWeeks } from "./records-sidebar";

/** How long a search waits for typing to pause before it asks the server. */
const SEARCH_DELAY_MS = 250;

const memberWeeksKey = (workspaceId: string | undefined) => [
  "records",
  workspaceId,
  "member-weeks",
];

/**
 * The member weeks the Records sidebar lists. The catalog holds the newest page (task #366);
 * `loadMore` reads older pages, and a search asks the server across every week once typing
 * pauses, showing the weeks already read, filtered, until it answers. Older pages read so far are
 * read again whenever the catalog is, so they never show what it no longer does.
 */
export function useRecordsMemberWeeks(
  catalog: RecordsCatalog,
  query: string,
  /** The weekly tab is shown: the Notes tab's search box never searches member weeks. */
  shown: boolean,
  /** The record or week on screen. A report's week older than the catalog's page is read on its
   * own and listed until the pages read reach it, so the sidebar shows where the reader is. */
  selection: { recordId?: string; weekKey?: string },
) {
  const workspaceId = useCurrentWorkspaceId();
  const queryClient = useQueryClient();
  const readOlder = useServerFn(loadOlderMemberWeeks);
  const search = useServerFn(searchMemberWeeks);

  const start = catalog.memberWeeksBefore;
  const [olderWanted, setOlderWanted] = useState(false);
  const older = useInfiniteQuery({
    queryKey: [...memberWeeksKey(workspaceId), "older", start?.year, start?.week],
    queryFn: ({ pageParam }) => readOlder({ data: { before: pageParam } }),
    initialPageParam: start ?? { year: 0, week: 1 },
    getNextPageParam: (page) => page.before ?? undefined,
    enabled: olderWanted && start !== null,
  });

  const shownCatalog = useRef(catalog);
  useEffect(() => {
    if (shownCatalog.current === catalog) return;
    shownCatalog.current = catalog;
    void queryClient.invalidateQueries({ queryKey: memberWeeksKey(workspaceId) });
  }, [catalog, queryClient, workspaceId]);

  // Blank text filters nothing, here or on the server.
  const searched = query.trim() ? query : "";
  const settled = useDebouncedValue(searched, SEARCH_DELAY_MS);
  const found = useQuery({
    queryKey: [...memberWeeksKey(workspaceId), "search", settled],
    queryFn: () => search({ data: { query: settled } }),
    enabled: shown && settled.length > 0,
  });

  const selectedCycle = useMatch({
    from: "/w/$workspaceSlug/records/$recordId",
    shouldThrow: false,
    select: (match) =>
      match.loaderData?.type === "report" ? match.loaderData.report.cycle : undefined,
  });
  const pinned = useWeekBeyondCatalog(catalog, selectedCycle, shown).read;

  const people = useMemo(
    () =>
      Object.assign(
        {},
        catalog.people,
        ...(older.data?.pages.map((page) => page.people) ?? []),
        pinned?.people,
        found.data?.people,
      ) as RecordsCatalog["people"],
    [catalog.people, older.data, pinned, found.data],
  );
  const weeks = useMemo(() => {
    if (searched && settled === searched && found.data) return found.data.memberWeeks;
    // The pinned week is older than every page read, or one of them now holds it: listed last,
    // once.
    const read = mergeMemberWeeks(
      catalog.memberWeeks,
      ...(older.data?.pages.map((page) => page.memberWeeks) ?? []),
      pinned?.memberWeeks ?? [],
    );
    return filterMemberWeeks(read, query, people);
  }, [searched, settled, found.data, catalog.memberWeeks, older.data, pinned, query, people]);

  // Any text filters what is listed (a search reads every week itself), so it pages no further.
  const hasMore = !query && (older.data ? older.hasNextPage : start !== null);
  function loadMore() {
    if (!olderWanted) setOlderWanted(true);
    else if (older.isFetching) return;
    else if (!older.data) void older.refetch();
    else if (older.hasNextPage) void older.fetchNextPage();
  }
  return {
    weeks,
    /** The record or week on screen is one of `weeks` (or in one). */
    selectionListed: weeks.some((week) =>
      isSelectedMemberWeek(week, selection.recordId, selection.weekKey),
    ),
    people,
    hasMore,
    loadMore,
    loadingMore: older.isFetching,
    loadFailed: older.isError,
  };
}

/** The member week of `cycle` read on its own, when it is older than the catalog's page. */
function useWeekBeyondCatalog(
  catalog: RecordsCatalog,
  cycle: { year: number; week: number } | undefined,
  enabled: boolean,
) {
  const workspaceId = useCurrentWorkspaceId();
  const readWeek = useServerFn(loadMemberWeekAt);
  const start = catalog.memberWeeksBefore;
  const beyond =
    cycle !== undefined &&
    start !== null &&
    (cycle.year < start.year || (cycle.year === start.year && cycle.week < start.week));
  const fetched = useQuery({
    queryKey: [...memberWeeksKey(workspaceId), "at", cycle?.year, cycle?.week],
    queryFn: () => readWeek({ data: { year: cycle!.year, week: cycle!.week } }),
    enabled: enabled && beyond,
  });
  return { beyond, read: beyond ? fetched.data : undefined };
}

/**
 * The member week of `cycle`: from the catalog's newest page, or read on its own when it is older
 * than that page, so a report opened by a link pages through its week's reports all the same.
 */
export function useMemberWeekAt(
  catalog: RecordsCatalog,
  cycle: { year: number; week: number },
  enabled: boolean,
) {
  const { beyond, read } = useWeekBeyondCatalog(catalog, cycle, enabled);
  if (!beyond)
    return catalog.memberWeeks.find((week) => week.year === cycle.year && week.week === cycle.week);
  return read?.memberWeeks[0];
}
