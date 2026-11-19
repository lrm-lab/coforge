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
  onRealtimeActivity,
}: {
  userId: string;
  workspaceId: string;
  filter: ActivityInboxFilter;
  onRealtimeActivity?: (refresh: () => void) => void;
}) {
  const queryClient = useQueryClient();
  const refreshList = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ACTIVITY_INBOX_QUERY_PREFIX }),
    [queryClient],
  );
  const refreshListsOnly = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ACTIVITY_INBOX_LISTS_KEY }),
    [queryClient],
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
    const queryKey = activityInboxQuery(workspaceId, filter).queryKey;
    void invalidateActivityInboxLists(queryClient, workspaceId);
    void loadFirstPage({ data: { filter } })
      .then((page) =>
        queryClient.setQueryData<{ pages: ActivityInboxPage[]; pageParams: unknown[] }>(
          queryKey,
          (current) =>
            current ? { ...current, pages: [page, ...current.pages.slice(1)] } : current,
        ),
      )
      .catch(() => undefined);
  }, [filter, loadFirstPage, queryClient, workspaceId]);
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
