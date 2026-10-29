import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { keepPreviousData, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign, CheckDone01, Inbox01, Mail01, Pin01 } from "@untitledui/icons";

import { Tab, TabList, Tabs } from "#src/components/application/tabs/tabs";
import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { PageHeader } from "#src/components/layout/page-header";
import { LIST_BESIDE_CLASSES } from "#src/features/conversations/conversation-list-button";
import { ConversationListResizeHandle } from "#src/features/conversations/conversation-list-resize-handle";
import { LIST_COLUMN } from "#src/features/conversations/conversation-list-width";
import { useRefreshSidebarLists } from "#src/features/conversations/sidebar-lists";
import { cn } from "#src/lib/utils";
import type { HostedConversationTarget } from "#src/features/conversations/conversation-page-search";
import { m } from "#src/paraglide/messages";
import type { ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";
import { loadActivityInbox, markActivityInboxRead } from "./activity-inbox.functions";
import { useActivityInboxRealtime } from "./use-activity-inbox-realtime";
import {
  ACTIVITY_INBOX_QUERY_PREFIX,
  activityInboxQuery,
  type ActivityInboxPage,
} from "./activity-inbox-queries";
import { useActivityDoneProjection } from "./activity-inbox-done";
import type { ActivityInboxFilter } from "./activity-inbox.schemas";
import { ActivityInboxEmpty, ActivityInboxLoadError } from "./activity-inbox-states";
import { ACTIVITY_LIST_BESIDE_FROM, ActivityConversationPane } from "./activity-conversation-pane";
import { openedItemKey } from "./activity-open-target";
import { useActivityItemActions } from "./use-activity-item-actions";
import { ActivityInboxRow } from "./activity-inbox-row";

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

  const firstPage = projectedData?.pages[0];
  const pinned = useMemo(() => firstPage?.pinned ?? [], [firstPage]);
  // Pages are offsets into a list that can move between fetches; an item that slid onto the next
  // page is shown once, and never again below Pinned.
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
  // request. Anything else that reaches the inbox still refreshes it whole.
  const loadFirstPage = useServerFn(loadActivityInbox);
  const refreshFirstPage = useCallback(() => {
    const queryKey = activityInboxQuery(workspaceId, filter).queryKey;
    void loadFirstPage({ data: { filter, offset: 0 } })
      .then((page) =>
        queryClient.setQueryData<{ pages: ActivityInboxPage[]; pageParams: unknown[] }>(
          queryKey,
          (current) =>
            current ? { ...current, pages: [page, ...current.pages.slice(1)] } : current,
        ),
      )
      .catch(() => undefined);
  }, [filter, loadFirstPage, queryClient, workspaceId]);
  useActivityInboxRealtime({
    userId: user.id,
    onMessage: refreshFirstPage,
    onActivity: refreshList,
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

  const empty = items.length === 0 && pinned.length === 0;
  const pinnedLabel = m.conversation_pinned_section();
  const sections = [
    {
      heading: <ActivityInboxSectionHeading icon={Pin01} label={pinnedLabel} />,
      label: pinnedLabel,
      items: pinned,
    },
    {
      heading: pinned.length > 0 && (
        <ActivityInboxSectionHeading
          label={m.activity_inbox_all_conversations()}
          className="pt-4"
        />
      ),
      label: m.navigation_activity(),
      items,
    },
  ].filter((section) => section.items.length > 0);

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
            <span
              data-activity-active-count
              className="shrink-0 text-sm text-tertiary tabular-nums"
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
            <Button size="sm" color="secondary" iconLeading={CheckDone01} onClick={readAll}>
              {m.activity_inbox_mark_all_read()}
            </Button>
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
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {query.isError && empty ? (
          <ActivityInboxLoadError onRetry={() => void query.refetch()} />
        ) : empty ? (
          <ActivityInboxEmpty filter={filter} onShowAll={() => onFilterChange("all")} />
        ) : (
          sections.map((section) => (
            <Fragment key={section.label}>
              {section.heading}
              <ol aria-label={section.label} className="flex flex-col">
                {section.items.map(row)}
              </ol>
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
      <TabList type="underline" size="md" aria-label={m.activity_inbox_filter_label()}>
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
  className,
}: {
  icon?: typeof Pin01;
  label: string;
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
  const waiting = hasNextPage && !isFetchingNextPage && !failed;
  useEffect(() => {
    const element = sentinel.current;
    if (!element || !waiting) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void fetchNextPage();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [waiting, fetchNextPage]);
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
