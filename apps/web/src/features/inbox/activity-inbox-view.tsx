import {
  Fragment,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getRouteApi, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { CheckDone01, MessageQuestionCircle, Pin01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { PageHeader } from "#src/components/layout/page-header";
import { LIST_BESIDE_CLASSES } from "#src/features/conversations/conversation-list-button";
import { ConversationListResizeHandle } from "#src/features/conversations/conversation-list-resize-handle";
import { LIST_COLUMN } from "#src/features/conversations/conversation-list-width";
import { useRefreshSidebarLists } from "#src/features/conversations/sidebar-lists";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { cn } from "#src/lib/utils";
import type { HostedConversationTarget } from "#src/features/conversations/conversation-page-search";
import { m } from "#src/paraglide/messages";
import type { ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";
import { loadActivityInbox, markActivityInboxRead } from "./activity-inbox.functions";
import { useActivityInboxRealtime } from "./use-activity-inbox-realtime";
import { userConversationChannel } from "#src/features/conversations/conversation-realtime";
import { rereadQueryMissedBySubscribe } from "#src/features/realtime/query-stream-position";
import type { SubscribedRecovery } from "#src/features/realtime/subscription-gap";
import {
  ACTIVITY_INBOX_LISTS_KEY,
  ACTIVITY_INBOX_QUERY_PREFIX,
  activityInboxQuery,
  invalidateActivityInboxLists,
  type ActivityInboxPage,
  WAITING_CHOICE_CARDS_KEY,
  waitingChoiceCardsQuery,
} from "./activity-inbox-queries";
import { useActivityDoneProjection } from "./activity-inbox-done";
import type { ActivityInboxFilter } from "./activity-inbox.schemas";
import { ActivityInboxEmpty, ActivityInboxLoadError } from "./activity-inbox-states";
import { ACTIVITY_LIST_BESIDE_FROM, ActivityConversationPane } from "./activity-conversation-pane";
import { openedItemKey } from "./activity-open-target";
import { ActivityTaskPopup } from "./activity-task-popup";
import { useActivityItemActions } from "./use-activity-item-actions";
import { ActivityInboxRow } from "./activity-inbox-row";
import { useActivityDays } from "./activity-inbox-days";
import { ActivityInboxTabs } from "./activity-inbox-tabs";
import { ActivityInboxLoadMore, ActivityInboxSectionHeading } from "./activity-inbox-list-parts";
import { useActivityListKeyboard } from "./use-activity-list-keyboard";
import { WaitingChoiceRow } from "./waiting-choice-row";

const appRoute = getRouteApi("/w/$workspaceSlug");

/**
 * The Activity page: the viewer's items with activity past Done, newest first, the All view's
 * pinned conversations first. The list fills the page until a row is opened; the row's
 * conversation (for a thread or a reply, its thread alone) then opens, kept in the URL: from `lg` up
 * beside a narrowed list, and below it full-screen in place of the list, with a back arrow to the
 * list.
 */
export function ActivityInboxView({
  filter,
  onFilterChange,
  opened,
  onOpen,
  onClose,
}: {
  filter: ActivityInboxFilter;
  onFilterChange: (filter: ActivityInboxFilter) => void;
  /** The conversation the URL has open, at its jump message and open thread. */
  opened: HostedConversationTarget | undefined;
  onOpen: (target: HostedConversationTarget) => void;
  onClose: () => void;
}) {
  const { user, currentWorkspace } = appRoute.useLoaderData();
  const workspaceId = currentWorkspace?.id ?? "";
  const workspaceSlug = useWorkspaceSlug();
  const router = useRouter();
  const queryClient = useQueryClient();
  const markAllRead = useServerFn(markActivityInboxRead);
  const {
    start: startDone,
    settle: settleDone,
    project: projectDone,
  } = useActivityDoneProjection();

  // Another view starts at its top, however it was switched to (a tab, "Show all", the address).
  const listScroll = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    listScroll.current?.scrollTo({ top: 0 });
  }, [filter]);
  // Switching views keeps the current rows on screen until the next view has loaded.
  const query = useInfiniteQuery({
    ...activityInboxQuery(workspaceId, filter),
    placeholderData: keepPreviousData,
  });
  const prefetchFilter = useCallback(
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
  // Re-project pending Done rows after placeholder selection, which may reuse selected data.
  const projectedData = useMemo(
    () => (query.data ? projectDone(query.data) : undefined),
    [query.data, projectDone],
  );

  // The choice cards waiting on the viewer head the All view, so a question is not buried by chat.
  const waitingQuery = useQuery({
    ...waitingChoiceCardsQuery(workspaceId),
    enabled: filter === "all",
  });
  const [allWaiting, setAllWaiting] = useState(false);
  // A disabled query keeps its cached cards: the filter hides them on the other views.
  const waiting = (filter === "all" && waitingQuery.data) || [];
  // Folded again once few enough wait that nothing was folded.
  const expandedWaiting = allWaiting && waiting.length > WAITING_SHOWN;

  const firstPage = projectedData?.pages[0];
  const pinned = useMemo(() => firstPage?.pinned ?? [], [firstPage]);
  // Pages are read at different times from a list that moves: a first page read again can hold an
  // item a later page still holds. It is shown once, and never again below Pinned.
  const items = useMemo(() => {
    const seen = new Set(pinned.map((item) => item.key));
    return (projectedData?.pages ?? [])
      .flatMap((page) => page.items)
      .filter((item) => !seen.has(item.key) && seen.add(item.key));
  }, [projectedData, pinned]);

  const currentKey = useMemo(
    () => openedItemKey([...pinned, ...items], opened),
    [pinned, items, opened],
  );
  // A Task card opens its popup alone over the list (`taskAlone`); anything else, the pane.
  const taskAlone =
    opened?.taskAlone && opened.task !== undefined ? { ...opened, task: opened.task } : undefined;
  const pane = taskAlone ? undefined : opened;
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
        userConversationChannel(user.id),
        recovery,
        refreshLists,
        (data) => data?.pages[0]?.streamPositions,
      ),
    [filter, queryClient, refreshLists, user.id, workspaceId],
  );
  // A choice card posted, answered or withdrawn is announced to the person it asks as an Activity
  // change, once per burst.
  const refreshWaiting = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: WAITING_CHOICE_CARDS_KEY }),
    [queryClient],
  );
  useActivityInboxRealtime({
    userId: user.id,
    onMessage: refreshFirstPage,
    onActivity: () => {
      refreshLists();
      refreshWaiting();
    },
    onSubscribed,
    refreshOnPreferences: true,
  });

  // A failed change is shown in the toolbar with its retry until it succeeds or is dismissed.
  const [failure, setFailure] = useState<{ retry: () => void } | null>(null);
  const actions = useActivityItemActions({
    workspaceId,
    onChanged: refresh,
    onFailure: setFailure,
    onDoneStarted: startDone,
    onDoneSettled: settleDone,
  });

  // Reads only what the list showed: the server's own clock at the time it read the list.
  const loadedAt = firstPage?.loadedAt;
  const readAll = useCallback(() => {
    if (loadedAt === undefined) return;
    const run = () => {
      setFailure(null);
      void markAllRead({ data: { before: loadedAt } })
        .catch(() => setFailure({ retry: run }))
        .finally(refresh);
    };
    run();
  }, [markAllRead, loadedAt, refresh]);

  const days = useActivityDays(items, (item) => item.latest.createdAt);
  // The rows in the order they are laid out, which the keyboard walks.
  const { tabStopKey, listProps } = useActivityListKeyboard(
    useMemo(() => [...pinned, ...days.flatMap((day) => day.items)], [pinned, days]),
    actions,
  );
  // Not empty while the waiting cards are still being read: they may be all there is.
  const empty =
    items.length === 0 &&
    pinned.length === 0 &&
    waiting.length === 0 &&
    !(filter === "all" && waitingQuery.isPending);
  const row = (item: ActivityInboxItem, clock = false) => (
    <ActivityInboxRow
      key={item.key}
      item={item}
      filter={filter}
      actions={actions}
      viewerId={user.id}
      current={item.key === currentKey}
      tabStop={item.key === tabStopKey}
      onOpen={onOpen}
      clock={clock}
    />
  );
  // Waiting on you, Pinned, then the rest: each section that has rows, the rest headed only below
  // another.
  const sections: ActivitySection[] = [
    {
      label: m.activity_inbox_waiting(),
      icon: MessageQuestionCircle,
      // However many wait, they never push the conversations off the screen: the first few show,
      // the rest behind "N more", and the heading says how many in all.
      count: waiting.length,
      rows: (expandedWaiting ? waiting : waiting.slice(0, WAITING_SHOWN)).map((card) => (
        <WaitingChoiceRow key={card.messageId} card={card} onOpen={onOpen} />
      )),
      footer: waiting.length > WAITING_SHOWN && (
        // On the rows' text column, with room to tap.
        <div className="py-1.5 pl-[calc(var(--page-gutter)+3.125rem)]">
          <Button
            size="sm"
            color="link-gray"
            aria-expanded={expandedWaiting}
            onClick={() => setAllWaiting(!expandedWaiting)}
          >
            {expandedWaiting
              ? m.activity_inbox_waiting_fewer()
              : m.activity_inbox_waiting_more({ count: waiting.length - WAITING_SHOWN })}
          </Button>
        </div>
      ),
    },
    { label: m.conversation_pinned_section(), icon: Pin01, rows: pinned.map((item) => row(item)) },
    // The rest, a heading for each day (none before hydration, when no day can be named yet).
    ...days.map((day) => ({
      label: day.label ?? m.navigation_activity(),
      heading: day.label,
      dated: day.label !== undefined,
      rows: day.items.map((item) => row(item, day.label !== undefined)),
    })),
  ].filter((section) => section.rows.length > 0);

  const activeCount = firstPage?.activeItemCount;
  const list = (
    <div
      data-activity-list
      className={cn(
        "flex min-h-0 flex-col",
        // Raft's list column beside the conversation at `lg`, as wide as its handle keeps it.
        // Narrower, the conversation takes the page in its place; the list stays mounted.
        pane
          ? cn(
              "relative w-list-column shrink-0",
              LIST_BESIDE_CLASSES[ACTIVITY_LIST_BESIDE_FROM].list,
            )
          : "min-w-0 flex-1",
      )}
    >
      <PageHeader
        heading={m.navigation_activity()}
        meta={
          activeCount !== undefined && (
            // Gives way before the heading does when the column is narrow.
            <span
              data-activity-active-count
              className="min-w-0 truncate text-sm text-tertiary tabular-nums"
            >
              {m.activity_inbox_active_count({ count: activeCount })}
            </span>
          )
        }
        tabs={
          <ActivityInboxTabs
            filter={filter}
            onFilterChange={onFilterChange}
            onFilterIntent={prefetchFilter}
            counts={{
              // The previous filter remains as placeholder data while the next filter loads;
              // its counts must not be shown as if they belonged to the selected view.
              unread: query.isPlaceholderData ? undefined : firstPage?.unreadItemCount,
              mentions: query.isPlaceholderData ? undefined : firstPage?.unreadMentionItemCount,
            }}
          />
        }
        actions={
          !query.isPlaceholderData &&
          firstPage &&
          firstPage.unreadItemCount > 0 && (
            // A list column dragged narrow keeps the button as its icon, named in a tooltip, so
            // it never covers the heading.
            <>
              <Button
                size="sm"
                color="secondary"
                iconLeading={CheckDone01}
                className="hidden @[22rem]/tabbed-header:inline-flex"
                onClick={readAll}
              >
                {m.activity_inbox_mark_all_read()}
              </Button>
              <ButtonUtility
                size="sm"
                color="secondary"
                icon={CheckDone01}
                tooltip={m.activity_inbox_mark_all_read()}
                className="@[22rem]/tabbed-header:hidden"
                onClick={readAll}
              />
            </>
          )
        }
      />
      {failure && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-3 border-b border-secondary px-page py-2 text-sm text-error-primary"
        >
          <span className="min-w-0 flex-1">{m.activity_inbox_action_error()}</span>
          <Button size="sm" color="link-gray" onClick={failure.retry}>
            {m.activity_inbox_retry()}
          </Button>
          <Button size="sm" color="link-gray" onClick={() => setFailure(null)}>
            {m.activity_inbox_dismiss()}
          </Button>
        </div>
      )}
      <div
        ref={listScroll}
        {...listProps}
        className="@container/activity-list min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-1"
      >
        {query.isError && empty ? (
          <ActivityInboxLoadError onRetry={() => void query.refetch()} />
        ) : empty ? (
          <ActivityInboxEmpty filter={filter} onShowAll={() => onFilterChange("all")} />
        ) : (
          sections.map((section, index) => (
            <Fragment key={section.label}>
              {(section.icon || index > 0 || section.dated) && (
                <ActivityInboxSectionHeading
                  icon={section.icon}
                  label={section.heading ?? section.label}
                  count={section.count}
                  className={cn(index > 0 && "pt-4")}
                />
              )}
              <ol aria-label={section.label} className="flex flex-col">
                {section.rows}
              </ol>
              {section.footer}
            </Fragment>
          ))
        )}
        <ActivityInboxLoadMore
          hasNextPage={query.hasNextPage}
          isFetchingNextPage={query.isFetchingNextPage}
          failed={query.isFetchNextPageError}
          fetchNextPage={query.fetchNextPage}
        />
      </div>
      {pane && (
        <ConversationListResizeHandle
          column={LIST_COLUMN}
          visibleFrom={ACTIVITY_LIST_BESIDE_FROM}
        />
      )}
    </div>
  );
  // One tree at every width, so crossing `lg` keeps the list (and its scroll) mounted.
  return (
    <div className="flex h-full min-h-0 min-w-0">
      {list}
      {pane && (
        <ActivityConversationPane
          key={`${pane.kind}:${pane.id}`}
          target={pane}
          onOpen={onOpen}
          onClose={onClose}
        />
      )}
      {taskAlone && (
        <ActivityTaskPopup
          key={`${taskAlone.id}:${taskAlone.task}`}
          target={taskAlone}
          onOpen={onOpen}
          onClose={onClose}
        />
      )}
    </div>
  );
}

/** The waiting cards shown before the rest fold behind "N more". */
const WAITING_SHOWN = 3;

type ActivitySection = {
  label: string;
  heading?: string;
  icon?: typeof Pin01;
  count?: number;
  dated?: boolean;
  rows: ReactNode[];
  footer?: ReactNode;
};
