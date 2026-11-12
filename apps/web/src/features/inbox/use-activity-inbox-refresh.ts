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

/**
 * Keeps the Activity list read: what reaches the viewer in realtime reads the list (or only its
 * first page, for a message) and the waiting cards again. Returns `refresh`, which reads the list
 * and the Chat sidebar again after a change of the viewer's own, and `refreshWaiting`, which reads
 * the waiting cards again.
 */
export function useActivityInboxRefresh({
  userId,
  workspaceId,
  filter,
}: {
  userId: string;
  workspaceId: string;
  filter: ActivityInboxFilter;
}) {
  const queryClient = useQueryClient();
  const refreshList = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ACTIVITY_INBOX_QUERY_PREFIX }),
    [queryClient],
  );
  // A read here also changes the Chat sidebar's badges.
  const refreshSidebar = useRefreshSidebarLists();
  const refresh = useCallback(
    () => Promise.all([refreshList(), refreshSidebar()]).then(() => undefined),
    [refreshList, refreshSidebar],
  );
  // A message reads only the first page again: the rows below it keep their place and are read
  // again when the viewer scrolls to them, so a busy channel cannot make every loaded page a
  // request. Anything else that reaches the inbox still refreshes it whole. A read of the list
  // under way meanwhile cannot put the older first page back (`keepLaterFirstPage`).
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
  // What was published after the list's first page was read but before the subscription started
  // reaches the list only through a read.
  // Realtime refreshes the lists only: the nav dot hears the same events and reads itself.
  const refreshLists = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: ACTIVITY_INBOX_LISTS_KEY }),
    [queryClient],
  );
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
  // A choice card posted, answered or withdrawn is announced to the person it asks as an Activity
  // change, once per burst.
  const refreshWaiting = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: WAITING_CHOICE_CARDS_KEY }),
    [queryClient],
  );
  useActivityInboxRealtime({
    userId,
    workspaceId,
    onMessage: refreshFirstPage,
    onActivity: () => {
      refreshLists();
      refreshWaiting();
    },
    onSubscribed,
    refreshOnPreferences: true,
  });
  return { refresh, refreshWaiting };
}
