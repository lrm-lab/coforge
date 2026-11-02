import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  AtSign,
  CheckDone01,
  Inbox01,
  Mail01,
  MessageQuestionCircle,
  Pin01,
} from "@untitledui/icons";

import { Tab, TabList, Tabs } from "#src/components/application/tabs/tabs";
import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { PageHeader } from "#src/components/layout/page-header";
import { LIST_BESIDE_CLASSES } from "#src/features/conversations/conversation-list-button";
import { ConversationListResizeHandle } from "#src/features/conversations/conversation-list-resize-handle";
import { LIST_COLUMN } from "#src/features/conversations/conversation-list-width";
import { useRefreshSidebarLists } from "#src/features/conversations/sidebar-lists";
import { cn } from "#src/lib/utils";
import { useEndOfList } from "#src/lib/use-end-of-list";
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
  type ActivityInboxPage,
  WAITING_CHOICE_CARDS_KEY,
  waitingChoiceCardsQuery,
} from "./activity-inbox-queries";
import { useActivityDoneProjection } from "./activity-inbox-done";
import type { ActivityInboxFilter } from "./activity-inbox.schemas";
import { ActivityInboxEmpty, ActivityInboxLoadError } from "./activity-inbox-states";
import { ACTIVITY_LIST_BESIDE_FROM, ActivityConversationPane } from "./activity-conversation-pane";
import { openedItemKey } from "./activity-open-target";
import { useActivityItemActions } from "./use-activity-item-actions";
import { ActivityInboxRow } from "./activity-inbox-row";
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
    refreshOnPins: true,
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

  // Not empty while the waiting cards are still being read: they may be all there is.
  const empty =
    items.length === 0 &&
    pinned.length === 0 &&
    waiting.length === 0 &&
    !(filter === "all" && waitingQuery.isPending);
  const row = (item: ActivityInboxItem) => (
    <ActivityInboxRow
      key={item.key}
      item={item}
      filter={filter}
      actions={actions}
      viewerId={user.id}
      current={item.key === currentKey}
      onOpen={onOpen}
    />
  );
  // Waiting on you, Pinned, then the rest: each section that has rows, the rest headed only below
  // another.
  const sections = [
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
    { label: m.conversation_pinned_section(), icon: Pin01, rows: pinned.map(row) },
    {
      label: m.navigation_activity(),
      heading: m.activity_inbox_all_conversations(),
      rows: items.map(row),
    },
  ].filter((section) => section.rows.length > 0);

  const activeCount = firstPage?.activeItemCount;
  const list = (
    <div
      data-activity-list
      className={cn(
        "flex min-h-0 flex-col",
        // Raft's list column beside the conversation at `lg`, as wide as its handle keeps it.
        // Narrower, the conversation takes the page in its place; the list stays mounted.
        opened
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
            counts={{
              unread: firstPage?.unreadItemCount,
              mentions: firstPage?.unreadMentionItemCount,
            }}
          />
        }
        actions={
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
      <div ref={listScroll} className="min-h-0 flex-1 overflow-y-auto py-1">
        {query.isError && empty ? (
          <ActivityInboxLoadError onRetry={() => void query.refetch()} />
        ) : empty ? (
          <ActivityInboxEmpty filter={filter} onShowAll={() => onFilterChange("all")} />
        ) : (
          sections.map((section, index) => (
            <Fragment key={section.label}>
              {(section.icon || index > 0) && (
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
      {opened && (
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
      {opened && (
        <ActivityConversationPane
          key={`${opened.kind}:${opened.id}`}
          target={opened}
          onOpen={onOpen}
          onClose={onClose}
        />
      )}
    </div>
  );
}

/** The waiting cards shown before the rest fold behind "N more". */
const WAITING_SHOWN = 3;

const FILTER_TABS: ReadonlyArray<{
  id: ActivityInboxFilter;
  icon: typeof Inbox01;
  label: () => string;
}> = [
  { id: "all", icon: Inbox01, label: () => m.activity_inbox_filter_all() },
  { id: "unread", icon: Mail01, label: () => m.activity_inbox_filter_unread() },
  { id: "mentions", icon: AtSign, label: () => m.activity_inbox_filter_mentions() },
];

/**
 * All / Unread / Mentions as the Chat header's icon + label underline tabs. Unread and Mentions
 * carry how many rows have something unread and an unread mention; the numbers are the same
 * whichever tab is showing, and a zero shows nothing.
 */
function ActivityInboxTabs({
  filter,
  onFilterChange,
  counts,
}: {
  filter: ActivityInboxFilter;
  onFilterChange: (filter: ActivityInboxFilter) => void;
  counts: Partial<Record<ActivityInboxFilter, number>>;
}) {
  return (
    <Tabs
      selectedKey={filter}
      onSelectionChange={(key) => {
        const next = FILTER_TABS.find((tab) => tab.id === key);
        if (next) onFilterChange(next.id);
      }}
      className="w-max shrink-0"
    >
      {/* In a list column dragged narrow the tabs drop their icons, so the three still fit. */}
      <TabList
        type="underline"
        size="md"
        aria-label={m.activity_inbox_filter_label()}
        className="@max-[22rem]/tabbed-header:**:data-icon:hidden"
      >
        {FILTER_TABS.map((tab) => (
          <Tab key={tab.id} id={tab.id} icon={tab.icon}>
            {/* The official `badge` prop hides below `md`; the count must show on phones too. */}
            {({ isSelected, isHovered }) => {
              const count = counts[tab.id] ?? 0;
              return (
                <>
                  {tab.label()}
                  {count > 0 && (
                    <Badge
                      type="pill-color"
                      size="sm"
                      color={isSelected || isHovered ? "brand" : "gray"}
                      className="transition-inherit-all"
                    >
                      {count > 99 ? "99+" : count}
                    </Badge>
                  )}
                </>
              );
            }}
          </Tab>
        ))}
      </TabList>
    </Tabs>
  );
}

/** A list section's label (Pinned, All conversations): a tertiary subheading on the rows' inset,
 * with the section's mark when it has one. */
function ActivityInboxSectionHeading({
  icon: Icon,
  label,
  count,
  className,
}: {
  icon?: typeof Pin01;
  label: string;
  /** How many the section holds, after its label. */
  count?: number;
  className?: string;
}) {
  return (
    <h2
      className={cn(
        "flex items-center gap-1.5 px-page pt-2 pb-1 text-sm font-semibold text-tertiary",
        className,
      )}
    >
      {Icon && <Icon aria-hidden="true" className="size-3 shrink-0 text-fg-quaternary" />}
      {label}
      {count !== undefined && (
        <span className="font-normal text-quaternary tabular-nums">
          <span aria-hidden="true">· </span>
          {count}
        </span>
      )}
    </h2>
  );
}

/**
 * Asks for the next page as the end of the list scrolls into view. A failed page stops asking and
 * offers a retry instead, so a broken request is never repeated in a loop.
 */
function ActivityInboxLoadMore({
  hasNextPage,
  isFetchingNextPage,
  failed,
  fetchNextPage,
}: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  failed: boolean;
  fetchNextPage: () => Promise<unknown>;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  useEndOfList(sentinel, hasNextPage && !isFetchingNextPage && !failed, () => void fetchNextPage());
  if (!hasNextPage) return null;
  return (
    <div ref={sentinel} className="flex items-center justify-center gap-2 py-3 text-xs">
      {failed ? (
        <>
          <span className="text-error-primary">{m.activity_inbox_load_more_error()}</span>
          <Button size="sm" color="link-gray" onClick={() => void fetchNextPage()}>
            {m.activity_inbox_retry()}
          </Button>
        </>
      ) : isFetchingNextPage ? (
        <span className="text-tertiary">{m.activity_inbox_loading_more()}</span>
      ) : null}
    </div>
  );
}
