import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { MessageQuestionCircle, Pin01 } from "@untitledui/icons";
import { AnimatePresence, motion } from "motion/react";

import { Button } from "#src/components/base/buttons/button";
import { PageHeader } from "#src/components/layout/page-header";
import { TabHomeHeader } from "#src/components/layout/tab-home-header";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { useEdgeSwipeBack } from "#src/hooks/use-edge-swipe-back";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { LIST_BESIDE_CLASSES } from "#src/features/conversations/conversation-list-button";
import { ConversationListResizeHandle } from "#src/features/conversations/conversation-list-resize-handle";
import { LIST_COLUMN } from "#src/features/conversations/conversation-list-width";
import { useActivityFilterPrefetch } from "./use-activity-filter-prefetch";
import { animateFlipFromRect, consumeSharedRect } from "#src/lib/shared-element-rect";
import { DURATION_S, EASE_IN, EASE_OUT } from "#src/utils/motion-tokens";
import { cn } from "#src/lib/utils";
import type { HostedConversationTarget } from "#src/features/conversations/conversation-page-search";
import { m } from "#src/paraglide/messages";
import type { ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";
import { markActivityInboxRead } from "./activity-inbox.functions";
import { useActivityInboxRefresh } from "./use-activity-inbox-refresh";
import {
  activityInboxQuery,
  invalidateActivityInboxLists,
  optimisticallyCompleteActivityItems,
  type ActivityCompletionItem,
  waitingChoiceCardsQuery,
} from "./activity-inbox-queries";
import { createActivityDoneCoordinator, useActivityDoneProjection } from "./activity-inbox-done";
import type { ActivityInboxFilter } from "./activity-inbox.schemas";
import { ActivityInboxEmpty, ActivityInboxLoadError } from "./activity-inbox-states";
import {
  ACTIVITY_LIST_BESIDE_FROM,
  ActivityConversationPane,
  type ActivityPaneFlow,
} from "./activity-conversation-pane";
import { useActivityFlow } from "./use-activity-flow";
import { useKeptOpenRow } from "./use-kept-open-row";
import { openedItemKey } from "./activity-open-target";
import { ActivityTaskPopup } from "./activity-task-popup";
import { useActivityItemActions } from "./use-activity-item-actions";
import { ActivityInboxRow } from "./activity-inbox-row";
import { ActivityArtifactRow } from "./activity-artifact-row";
import { useActivityInboxGroups } from "./use-activity-inbox-groups";
import { daySectionKey } from "./activity-inbox-days";
import { ActivityInboxTabs } from "./activity-inbox-tabs";
import { ActivityInboxMoreMenu } from "./activity-inbox-more-menu";
import {
  ActivityInboxActionError,
  ActivityInboxLoadMore,
  ActivityInboxSections,
  type ActivitySection,
} from "./activity-inbox-list-parts";
import { useActivityListKeyboard, waitingRowKey } from "./use-activity-list-keyboard";
import { useActivityBulkActions } from "./use-activity-bulk-actions";
import { WaitingChoiceRow } from "./waiting-choice-row";

const appRoute = getRouteApi("/w/$workspaceSlug");

export function ActivityInboxView({
  filter,
  onFilterChange,
  opened,
  onOpen,
  onClose,
}: {
  filter: ActivityInboxFilter;
  onFilterChange: (filter: ActivityInboxFilter) => void;
  opened: HostedConversationTarget | undefined;
  onOpen: (target: HostedConversationTarget) => void;
  onClose: () => void;
}) {
  const { user, currentWorkspace } = appRoute.useLoaderData();
  const workspaceId = currentWorkspace?.id ?? "";
  const desktop = useBreakpoint("lg");
  const queryClient = useQueryClient();
  const markAllRead = useServerFn(markActivityInboxRead);
  const {
    start: startDone,
    settle: settleDone,
    project: projectDone,
  } = useActivityDoneProjection();

  const listScroll = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    listScroll.current?.scrollTo({ top: 0 });
  }, [filter]);
  const query = useInfiniteQuery({
    ...activityInboxQuery(workspaceId, filter),
    placeholderData: keepPreviousData,
  });
  const prefetchFilter = useActivityFilterPrefetch(filter);
  const projectedData = useMemo(
    () => (query.data ? projectDone(query.data) : undefined),
    [query.data, projectDone],
  );

  const waitingQuery = useQuery({
    ...waitingChoiceCardsQuery(workspaceId),
    enabled: filter === "all",
  });
  const [allWaiting, setAllWaiting] = useState(false);
  const waiting = (filter === "all" && waitingQuery.data) || [];
  const expandedWaiting = allWaiting && waiting.length > WAITING_SHOWN;

  const firstPage = projectedData?.pages[0];
  const pinned = useMemo(() => firstPage?.pinned ?? [], [firstPage]);
  const listed = useMemo(() => {
    const seen = new Set(pinned.map((item) => item.key));
    return (projectedData?.pages ?? [])
      .flatMap((page) => page.items)
      .filter((item) => !seen.has(item.key) && seen.add(item.key));
  }, [projectedData, pinned]);
  const { items, release } = useKeptOpenRow(filter, listed, opened);
  const onDoneStarted = useCallback(
    (item: ActivityCompletionItem) => {
      release(item.key);
      startDone(item);
    },
    [release, startDone],
  );

  const currentKey = useMemo(
    () => openedItemKey([...pinned, ...items], opened),
    [pinned, items, opened],
  );
  const taskAlone =
    opened?.taskAlone && opened.task !== undefined ? { ...opened, task: opened.task } : undefined;
  const pane = taskAlone ? undefined : opened;
  const refreshAfterDoneRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const externalRealtimeRef = useRef<() => void>(() => undefined);
  const doneCoordinator = useMemo(
    () =>
      createActivityDoneCoordinator({
        onStart: (item) => {
          onDoneStarted(item);
          optimisticallyCompleteActivityItems(queryClient, workspaceId, [item]);
        },
        onSettle: settleDone,
        onMarkOtherListsStale: () => void invalidateActivityInboxLists(queryClient, workspaceId),
        onReconcile: () => refreshAfterDoneRef.current(),
        onExternalRealtimeActivity: () => externalRealtimeRef.current(),
      }),
    [onDoneStarted, queryClient, settleDone, workspaceId],
  );
  useEffect(() => () => doneCoordinator.dispose(), [doneCoordinator]);
  const onRealtimeActivity = useCallback(
    (runRealtimeRefresh: () => void) => {
      externalRealtimeRef.current = runRealtimeRefresh;
      doneCoordinator.onRealtimeActivity();
    },
    [doneCoordinator],
  );
  const { refresh, refreshAfterDone, refreshWaiting } = useActivityInboxRefresh({
    userId: user.id,
    workspaceId,
    filter,
    onRealtimeActivity,
  });
  refreshAfterDoneRef.current = refreshAfterDone;

  const [failure, setFailure] = useState<{ retry: () => void } | null>(null);
  const actions = useActivityItemActions({
    workspaceId,
    onChanged: refresh,
    onFailure: setFailure,
    enqueueDone: doneCoordinator.enqueue,
  });

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

  const { unread, days, rows } = useActivityInboxGroups(filter, items, pinned);
  const { doneAll } = useActivityBulkActions({
    workspaceId,
    onChanged: refresh,
    onFailure: setFailure,
    onDoneStarted,
    onDoneSettled: settleDone,
  });
  const shownWaiting = expandedWaiting ? waiting : waiting.slice(0, WAITING_SHOWN);
  const rowKeys = [
    ...shownWaiting.map((card) => waitingRowKey(card.messageId)),
    ...rows.map((item) => item.key),
  ];
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const listFlow = useActivityFlow({
    flowing: desktop && pane !== undefined,
    rows,
    waiting: shownWaiting,
    currentKey,
    pane,
    onOpen,
    composerRef,
  });
  const { tabStopKey, listProps, headerProps, paneProps, actOnSelected, focusSelected } =
    useActivityListKeyboard(rowKeys, rows, actions, listFlow);
  const selectedDone = rows.some((item) => item.key === tabStopKey);
  const flowing = listFlow !== undefined;
  const paneFlow = useMemo<ActivityPaneFlow | undefined>(
    () =>
      flowing
        ? {
            done: selectedDone,
            composerRef,
            onListKey: actOnSelected,
            onKeyDown: paneProps.onKeyDown,
            onBackToList: focusSelected,
          }
        : undefined,
    [flowing, selectedDone, actOnSelected, paneProps.onKeyDown, focusSelected],
  );
  const empty =
    items.length === 0 &&
    pinned.length === 0 &&
    waiting.length === 0 &&
    !(filter === "all" && waitingQuery.isPending);
  const row = (item: ActivityInboxItem, clock = false) =>
    item.kind === "artifact" ? (
      <ActivityArtifactRow
        key={item.key}
        item={item}
        filter={filter}
        actions={actions}
        tabStop={item.key === tabStopKey}
        clock={clock}
      />
    ) : (
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
  const sections: ActivitySection[] = [
    {
      key: "waiting",
      label: m.activity_inbox_waiting(),
      icon: MessageQuestionCircle,
      count: waiting.length,
      rows: shownWaiting.map((card) => (
        <WaitingChoiceRow
          key={card.messageId}
          card={card}
          tabStop={waitingRowKey(card.messageId) === tabStopKey}
          onOpen={onOpen}
          onDeclined={refreshWaiting}
        />
      )),
      footer: waiting.length > WAITING_SHOWN && (
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
    {
      key: "unread",
      label: m.activity_inbox_filter_unread(),
      count: firstPage?.unreadItemCount,
      rows: unread.map((item) => row(item)),
    },
    {
      key: "pinned",
      label: m.conversation_pinned_section(),
      icon: Pin01,
      rows: pinned.map((item) => row(item)),
    },
    ...days.map((day, index) => ({
      key: daySectionKey(index, day.key),
      label: day.label ?? m.navigation_activity(),
      heading: day.label,
      dated: day.label !== undefined,
      rows: day.items.map((item) => row(item, day.label !== undefined)),
    })),
  ].filter((section) => section.rows.length > 0);

  const activeCount = firstPage?.activeItemCount;
  const activeCountMeta = activeCount !== undefined && (
    <span
      data-activity-active-count
      className="min-w-0 truncate text-sm text-tertiary tabular-nums"
    >
      {m.activity_inbox_active_count({ count: activeCount })}
    </span>
  );
  const filterTabs = (
    <ActivityInboxTabs
      filter={filter}
      onFilterChange={onFilterChange}
      onFilterIntent={prefetchFilter}
      counts={{
        unread: query.isPlaceholderData ? undefined : firstPage?.unreadItemCount,
        mentions: query.isPlaceholderData ? undefined : firstPage?.unreadMentionItemCount,
        artifacts: query.isPlaceholderData ? undefined : firstPage?.unreadArtifactItemCount,
      }}
    />
  );
  const moreActions = !query.isPlaceholderData &&
    firstPage &&
    filter !== "mentions" &&
    (firstPage.unreadItemCount > 0 || (filter === "all" && items.length > 0)) && (
      <ActivityInboxMoreMenu
        onReadAll={firstPage.unreadItemCount > 0 ? readAll : undefined}
        onDoneAll={
          filter === "all" && loadedAt !== undefined && items.length > 0
            ? () => doneAll(loadedAt, items)
            : undefined
        }
      />
    );
  const reduced = usePrefersReducedMotion();
  const phone = !desktop;
  const paneWrapRef = useRef<HTMLDivElement>(null);
  const swipe = useEdgeSwipeBack({
    enabled: phone && Boolean(pane) && !reduced,
    onBack: onClose,
  });

  useLayoutEffect(() => {
    if (!phone || !pane || reduced || !paneWrapRef.current) return;
    const header = paneWrapRef.current.querySelector("header");
    const avatarRect = consumeSharedRect("activity-row-avatar");
    const titleRect = consumeSharedRect("activity-row-title");
    if (header && avatarRect) {
      const avatarTarget = header.querySelector<HTMLElement>("[data-avatar], .avatar-group");
      if (avatarTarget)
        animateFlipFromRect(avatarTarget, avatarRect, { duration: 420, mode: "uniform" });
    }
    if (header && titleRect) {
      const titleTarget = header.querySelector<HTMLElement>("h1, h2");
      if (titleTarget)
        animateFlipFromRect(titleTarget, titleRect, { duration: 420, mode: "uniform" });
    }
  }, [pane, phone, reduced]);

  const phoneListStyle: CSSProperties | undefined = phone
    ? reduced
      ? {
          opacity: pane ? 0 : 1,
          transition: "opacity 150ms var(--ease-out)",
        }
      : {
          transform: pane
            ? `translate3d(${(1 - swipe.dragProgress) * -10}%, 0, 0) scale(${0.95 + 0.05 * swipe.dragProgress})`
            : "translate3d(0, 0, 0) scale(1)",
          transition: !swipe.dragging
            ? swipe.settling
              ? "transform calc(var(--duration-md) * 1.5) var(--ease-spring)"
              : `transform ${pane ? "var(--duration-lg)" : "var(--duration-lg-out)"} var(--ease-in-out)`
            : undefined,
        }
    : undefined;
  const phoneScrimOpacity = phone && !reduced && pane ? 0.24 * (1 - swipe.dragProgress) : 0;

  const list = (
    <div
      data-activity-list
      {...headerProps}
      inert={phone && pane ? true : undefined}
      aria-hidden={phone && pane ? true : undefined}
      style={phoneListStyle}
      className={cn(
        "relative flex min-h-0 flex-col bg-primary max-lg:absolute max-lg:inset-0 max-lg:z-10 max-lg:will-change-transform",
        phone && pane && "pointer-events-none",
        pane
          ? cn(
              "lg:relative lg:w-list-column lg:shrink-0",
              desktop && LIST_BESIDE_CLASSES[ACTIVITY_LIST_BESIDE_FROM].list,
            )
          : "min-w-0 flex-1",
      )}
    >
      {desktop ? (
        <PageHeader
          heading={m.navigation_activity()}
          meta={activeCountMeta}
          tabsStart
          tabs={filterTabs}
          actions={moreActions}
        />
      ) : (
        <>
          <TabHomeHeader title={m.navigation_activity()} meta={activeCountMeta} />
          <div className="flex shrink-0 items-center gap-2 border-b border-secondary px-page py-2">
            <div className="flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {filterTabs}
            </div>
            {moreActions}
          </div>
        </>
      )}
      {failure && (
        <ActivityInboxActionError onRetry={failure.retry} onDismiss={() => setFailure(null)} />
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
          <ActivityInboxSections sections={sections} />
        )}
        <ActivityInboxLoadMore
          hasNextPage={query.hasNextPage}
          isFetchingNextPage={query.isFetchingNextPage}
          failed={query.isFetchNextPageError}
          fetchNextPage={() => query.fetchNextPage({ cancelRefetch: false })}
        />
      </div>
      {pane && (
        <ConversationListResizeHandle
          column={LIST_COLUMN}
          visibleFrom={ACTIVITY_LIST_BESIDE_FROM}
        />
      )}
      {phone && !reduced && (
        <div
          aria-hidden="true"
          style={{
            opacity: phoneScrimOpacity,
            transition: !swipe.dragging
              ? `opacity ${pane ? "var(--duration-lg) var(--ease-out)" : "var(--duration-lg-out) var(--ease-in)"}`
              : undefined,
          }}
          className="pointer-events-none absolute inset-0 z-30 bg-black"
        />
      )}
    </div>
  );
  return (
    <div className="relative flex h-full min-h-0 min-w-0 overflow-hidden lg:overflow-visible">
      {list}
      {desktop ? (
        pane && (
          <ActivityConversationPane
            key={`${pane.kind}:${pane.id}`}
            target={pane}
            onOpen={onOpen}
            onClose={onClose}
            flow={paneFlow}
          />
        )
      ) : (
        <AnimatePresence initial={false}>
          {pane && (
            <motion.div
              ref={paneWrapRef}
              key={`${pane.kind}:${pane.id}`}
              {...swipe.bind}
              initial={reduced ? { opacity: 0 } : { x: "100%" }}
              animate={
                reduced
                  ? { opacity: 1 }
                  : swipe.dragging
                    ? { x: `${swipe.dragProgress * 100}%` }
                    : { x: 0 }
              }
              exit={
                reduced
                  ? { opacity: 0, transition: { duration: DURATION_S.reduced } }
                  : { x: "100%", transition: { duration: DURATION_S.lgOut, ease: EASE_IN } }
              }
              transition={
                swipe.dragging
                  ? { duration: 0 }
                  : reduced
                    ? { duration: DURATION_S.reduced }
                    : swipe.settling
                      ? { type: "spring", stiffness: 380, damping: 32 }
                      : { duration: DURATION_S.lg, ease: EASE_OUT }
              }
              className="absolute inset-0 z-20 flex min-h-0 min-w-0 touch-pan-y bg-primary shadow-2xl will-change-transform"
            >
              <ActivityConversationPane
                target={pane}
                onOpen={onOpen}
                onClose={onClose}
                flow={paneFlow}
              />
            </motion.div>
          )}
        </AnimatePresence>
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

const WAITING_SHOWN = 3;
