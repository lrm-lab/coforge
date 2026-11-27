import { useCallback } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";

import { userConversationChannel } from "#src/features/conversations/conversation-realtime";
import { useRefreshSidebarLists } from "#src/features/conversations/sidebar-lists";
import { rereadQueryMissedBySubscribe } from "#src/features/realtime/query-stream-position";
import type { SubscribedRecovery } from "#src/features/realtime/subscription-gap";
import { loadActivityInbox } from "./activity-inbox.functions";
import {
  ACTIVITY_INBOX_LISTS_KEY,
  ACTIVITY_INBOX_QUERY_PREFIX,
  activityInboxQuery,
  invalidateActivityInboxLists,
  type ActivityInboxPage,
  WAITING_CHOICE_CARDS_KEY,
} from "./activity-inbox-queries";
import type { ActivityInboxFilter } from "./activity-inbox.schemas";
import { useActivityInboxRealtime } from "./use-activity-inbox-realtime";

export function useActivityInboxRefresh({
  userId,
  workspaceId,
  filter,
  selected,
  onRealtimeActivity,
}: {
  userId: string;
  workspaceId: string;
  filter: ActivityInboxFilter;
  selected: { current: string | undefined };
  onRealtimeActivity?: (refresh: () => void) => void;
}) {
  const queryClient = useQueryClient();
  const restartAll = useCallback(async () => {
    const options = activityInboxQuery(workspaceId, "all", selected);
    const cached = queryClient.getQueryCache().find({ queryKey: options.queryKey, exact: true });
    if (!cached?.isActive()) {
      await queryClient.invalidateQueries({
        queryKey: options.queryKey,
        exact: true,
        refetchType: "none",
      });
      return;
    }
    await queryClient.cancelQueries({ queryKey: options.queryKey, exact: true });
    await queryClient
      .fetchInfiniteQuery({ ...options, pages: 1, staleTime: 0 })
      .catch(() => undefined);
  }, [queryClient, workspaceId, selected]);
  const refreshMatching = useCallback(
    (queryKey: readonly unknown[]) =>
      Promise.all([
        restartAll(),
        queryClient.invalidateQueries({
          queryKey,
          predicate: (query) =>
            !(
              query.queryKey[1] === "list" &&
              query.queryKey[2] === workspaceId &&
              query.queryKey[3] === "all"
            ),
        }),
      ]).then(() => undefined),
    [queryClient, restartAll, workspaceId],
  );
  const refreshList = useCallback(
    () => refreshMatching(ACTIVITY_INBOX_QUERY_PREFIX),
    [refreshMatching],
  );
  const refreshListsOnly = useCallback(
    () => refreshMatching(ACTIVITY_INBOX_LISTS_KEY),
    [refreshMatching],
  );
  const refreshSidebar = useRefreshSidebarLists();
  const refresh = useCallback(
    () => Promise.all([refreshList(), refreshSidebar()]).then(() => undefined),
    [refreshList, refreshSidebar],
  );
  const refreshAfterDone = useCallback(
    () => Promise.all([refreshListsOnly(), refreshSidebar()]).then(() => undefined),
    [refreshListsOnly, refreshSidebar],
  );
  const loadFirstPage = useServerFn(loadActivityInbox);
  const refreshFirstPage = useCallback(() => {
    void invalidateActivityInboxLists(queryClient, workspaceId);
    if (filter === "all") {
      void restartAll();
      return;
    }
    const queryKey = activityInboxQuery(workspaceId, filter).queryKey;
    void loadFirstPage({ data: { filter } })
      .then((page) =>
        queryClient.setQueryData<{ pages: ActivityInboxPage[]; pageParams: unknown[] }>(
          queryKey,
          (current) =>
            current
              ? { ...current, pages: [page, ...current.pages.slice(1)] }
              : { pages: [page], pageParams: [undefined] },
        ),
      )
      .catch(() => undefined);
  }, [filter, loadFirstPage, queryClient, workspaceId, restartAll]);
  const refreshLists = useCallback(() => void refreshListsOnly(), [refreshListsOnly]);
  const onSubscribed = useCallback(
    (recovery: SubscribedRecovery) =>
      void rereadQueryMissedBySubscribe<{ pages: ActivityInboxPage[] }>(
        queryClient,
        activityInboxQuery(workspaceId, filter).queryKey,
        userConversationChannel(userId),
        recovery,
        refreshLists,
        (data) => data?.pages[0]?.streamPositions,
      ),
    [filter, queryClient, refreshLists, userId, workspaceId],
  );
  const refreshWaiting = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: WAITING_CHOICE_CARDS_KEY }),
    [queryClient],
  );
  const refreshRealtimeActivity = useCallback(() => {
    refreshLists();
    refreshWaiting();
  }, [refreshLists, refreshWaiting]);
  useActivityInboxRealtime({
    userId,
    workspaceId,
    onMessage: refreshFirstPage,
    onActivity: () => {
      if (onRealtimeActivity) onRealtimeActivity(refreshRealtimeActivity);
      else refreshRealtimeActivity();
    },
    onSubscribed,
    refreshOnPreferences: true,
  });
  return { refresh, refreshAfterDone, refreshWaiting };
}
