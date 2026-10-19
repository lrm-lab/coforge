import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getRouteApi, Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  Activity,
  AtSign,
  BellOff01,
  Check,
  CheckDone01,
  Hash01,
  Inbox01,
  Mail01,
  MessageTextSquare01,
  Pin01,
  User01,
} from "@untitledui/icons";
import { Link as AriaLink } from "react-aria-components";

import { Tab, TabList, Tabs } from "#src/components/application/tabs/tabs";
import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { PageHeader } from "#src/components/layout/page-header";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#src/components/ui/empty";
import { RelativeTime } from "#src/components/ui/relative-time";
import {
  markPublicChannelRead,
  markPublicChannelThreadRead,
  setPublicChannelThreadFollowed,
  setPublicConversationUnread,
} from "#src/features/conversations/channels.functions";
import {
  markDirectConversationRead,
  markDirectThreadRead,
  setDirectConversationUnread,
} from "#src/features/conversations/conversations.functions";
import { MessagePreview } from "#src/features/conversations/message-preview";
import { useRefreshSidebarLists } from "#src/features/conversations/sidebar-lists";
import { TASK_STATUS_COLOR } from "#src/features/tasks/task-workflow";
import { cn } from "#src/lib/utils";
import { DeletedAgentBadge } from "#src/features/agents/deleted-agent";
import { LiveAgentAvatar } from "#src/features/agents/live-agent-avatar";
import { MemberAvatar } from "#src/features/workspaces/member-avatar";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import type { HostedConversationTarget } from "#src/features/conversations/conversation-page-search";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { m } from "#src/paraglide/messages";
import type { ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";
import {
  markActivityInboxRead,
  markActivityItemDone,
  setActivityMentionRead,
} from "./activity-inbox.functions";
import { useActivityInboxRealtime } from "./use-activity-inbox-realtime";
import {
  ACTIVITY_INBOX_LISTS_KEY,
  ACTIVITY_INBOX_QUERY_PREFIX,
  activityInboxQuery,
  type ActivityInboxPage,
} from "./activity-inbox-queries";
import type { ActivityInboxFilter } from "./activity-inbox.schemas";
import { ActivityConversationPane } from "./activity-conversation-pane";
import { activityChatLink, activityOpenTarget, openedItemKey } from "./activity-open-target";

const appRoute = getRouteApi("/w/$workspaceSlug");

/**
 * The Activity page: the viewer's items with activity past Done, newest first, the All view's
 * pinned conversations first. The list fills the page until a row is opened; from `lg` up the row's
 * conversation then opens beside a narrowed list (kept in the URL), and below `lg` a row opens it
 * in Chat. Below `lg` a URL that names a conversation (a reload, a shared link, a window narrowed
 * with one open) shows it full-screen in place of the list, with a back arrow to the list.
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

  // Switching views keeps the current rows on screen until the next view has loaded.
  const query = useInfiniteQuery({
    ...activityInboxQuery(workspaceId, filter),
    placeholderData: keepPreviousData,
  });

  const firstPage = query.data?.pages[0];
  const pinned = useMemo(() => firstPage?.pinned ?? [], [firstPage]);
  // Pages are offsets into a list that can move between fetches; an item that slid onto the next
  // page is shown once, and never again below Pinned.
  const items = useMemo(() => {
    const seen = new Set(pinned.map((item) => item.key));
    return (query.data?.pages ?? [])
      .flatMap((page) => page.items)
      .filter((item) => !seen.has(item.key) && seen.add(item.key));
  }, [query.data, pinned]);

  const currentKey = useMemo(
    () => openedItemKey([...pinned, ...items], opened),
    [pinned, items, opened],
  );
  // A row opens its conversation beside the list only at the width Chat pins them side by side
  // (`lg`); narrower, the row opens Chat instead.
  const wide = useBreakpoint("lg");

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
  useActivityInboxRealtime({
    workspaceId,
    userId: user.id,
    onActivity: refreshList,
    refreshOnPins: true,
  });

  // A failed change is shown in the toolbar with its retry until it succeeds or is dismissed.
  const [failure, setFailure] = useState<{ retry: () => void } | null>(null);
  const actions = useActivityItemActions({
    workspaceId,
    onChanged: refresh,
    onFailure: setFailure,
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
      onOpen={wide ? onOpen : undefined}
    />
  );

  const activeCount = firstPage?.activeItemCount;
  const list = (
    <div
      data-activity-list
      className={cn(
        "flex min-h-0 flex-col",
        // Raft's 35rem column, at most half the page so the conversation keeps room at `lg`.
        // Narrower, the conversation takes the page in its place; the list stays mounted.
        opened ? "w-[min(35rem,50%)] shrink-0 max-lg:hidden" : "min-w-0 flex-1",
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
          className="flex shrink-0 items-center gap-3 border-b border-secondary px-4 py-2 text-sm text-error-primary sm:px-6"
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
        "flex items-center gap-1.5 px-4 pt-2 pb-1 text-sm font-semibold text-tertiary sm:px-6",
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

type ActivityItemActions = ReturnType<typeof useActivityItemActions>;

/**
 * What a row can do. Reading, marking unread and following reuse the conversation's own
 * functions, so the Chat sidebar and the inbox move the same cursors. Done hides the row at once
 * and the refetch puts it back if the server refused. The returned object is stable, so rows
 * re-render only when their own item changes.
 */
function useActivityItemActions({
  workspaceId,
  onChanged,
  onFailure,
}: {
  workspaceId: string;
  onChanged: () => Promise<void>;
  onFailure: (failure: { retry: () => void } | null) => void;
}) {
  const queryClient = useQueryClient();
  const markChannelRead = useServerFn(markPublicChannelRead);
  const markChannelThreadRead = useServerFn(markPublicChannelThreadRead);
  const markDirectRead = useServerFn(markDirectConversationRead);
  const markDirectThread = useServerFn(markDirectThreadRead);
  const setChannelUnread = useServerFn(setPublicConversationUnread);
  const setDirectUnread = useServerFn(setDirectConversationUnread);
  const setThreadFollowed = useServerFn(setPublicChannelThreadFollowed);
  const markDone = useServerFn(markActivityItemDone);
  const setMentionRead = useServerFn(setActivityMentionRead);

  return useMemo(() => {
    function run(action: () => Promise<unknown>) {
      onFailure(null);
      // Through a resolved promise, so an action that throws before it returns a promise is
      // reported like one that rejects.
      void Promise.resolve()
        .then(action)
        .catch(() => onFailure({ retry: () => run(action) }))
        .finally(onChanged);
    }

    function read({
      place,
      thread,
      latestSequence: throughSequence,
      mentionAction,
    }: ActivityInboxItem) {
      // A mention the viewer was notified of keeps its own read state: they are not in the channel.
      if (mentionAction)
        return setMentionRead({ data: { resolutionId: mentionAction.resolutionId, read: true } });
      if (thread) {
        const threadRootId = thread.root.id;
        return place.kind === "channel"
          ? markChannelThreadRead({
              data: { channelId: place.conversationId, threadRootId, throughSequence },
            })
          : markDirectThread({
              data: { conversationId: place.conversationId, threadRootId, throughSequence },
            });
      }
      return place.kind === "channel"
        ? markChannelRead({ data: { channelId: place.conversationId, throughSequence } })
        : markDirectRead({ data: { conversationId: place.conversationId, throughSequence } });
    }

    return {
      read: (item: ActivityInboxItem) => run(() => read(item)),
      // Saved directly: the sidebar's optimistic lists are synced only on the Chat page, and the
      // refresh afterwards brings the sidebar's badge along.
      unread: ({ place, mentionAction }: ActivityInboxItem) =>
        run(() =>
          mentionAction
            ? setMentionRead({ data: { resolutionId: mentionAction.resolutionId, read: false } })
            : place.kind === "channel"
              ? setChannelUnread({ data: { channelId: place.conversationId, unread: true } })
              : setDirectUnread({ data: { conversationId: place.conversationId, unread: true } }),
        ),
      unfollow: ({ place, thread }: ActivityInboxItem) => {
        if (!thread) return;
        run(() =>
          setThreadFollowed({
            data: {
              channelId: place.conversationId,
              threadRootId: thread.root.id,
              followed: false,
            },
          }),
        );
      },
      done: (item: ActivityInboxItem) => {
        queryClient.setQueriesData<InfiniteData<ActivityInboxPage>>(
          // Every view of this Workspace: the counts cover them all.
          { queryKey: [...ACTIVITY_INBOX_LISTS_KEY, workspaceId] },
          (data) => data && withoutItem(data, item),
        );
        run(() =>
          markDone({
            data: item.mentionAction
              ? { kind: "mention_action", resolutionId: item.mentionAction.resolutionId }
              : item.thread
                ? {
                    kind: "thread",
                    conversationId: item.place.conversationId,
                    rootMessageId: item.thread.root.id,
                    throughSequence: item.latestSequence,
                  }
                : {
                    kind: "conversation",
                    conversationId: item.place.conversationId,
                    throughSequence: item.latestSequence,
                  },
          }),
        );
      },
    };
  }, [
    queryClient,
    workspaceId,
    onChanged,
    onFailure,
    markChannelRead,
    markChannelThreadRead,
    markDirectRead,
    markDirectThread,
    setChannelUnread,
    setDirectUnread,
    setThreadFollowed,
    markDone,
    setMentionRead,
  ]);
}

/**
 * A cached view of the item's Workspace without the item, until the refetch lands. The tab counts
 * and the active count cover every view, so each view drops the item from them, whether or not it
 * lists the item. A pinned conversation stays under Pinned after Done, so the Pinned section keeps
 * it and it still counts as active.
 */
function withoutItem(
  data: InfiniteData<ActivityInboxPage>,
  item: ActivityInboxItem,
): InfiniteData<ActivityInboxPage> {
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.filter((entry) => entry.key !== item.key),
      unreadItemCount: Math.max(0, page.unreadItemCount - (item.unreadCount > 0 ? 1 : 0)),
      unreadMentionItemCount: Math.max(
        0,
        page.unreadMentionItemCount - (item.unreadMention ? 1 : 0),
      ),
      activeItemCount: Math.max(0, page.activeItemCount - (item.pinned ? 0 : 1)),
    })),
  };
}

/** A message's text rendered as inline Markdown, or its first attachment's name. */
function Preview({ message }: { message: ActivityInboxItem["latest"] }) {
  if (message.body) return <MessagePreview body={message.body} mentions={message.mentions} />;
  return <>{message.attachments[0]?.fileName ?? ""}</>;
}

const ActivityInboxRow = memo(function ActivityInboxRow({
  item,
  filter,
  actions,
  viewerId,
  current,
  onOpen,
}: {
  item: ActivityInboxItem;
  filter: ActivityInboxFilter;
  actions: ActivityItemActions;
  viewerId: string;
  /** This row stands for the conversation open beside the list. */
  current: boolean;
  /** Opens the row beside the list; undefined when there is no room, so the row opens Chat. */
  onOpen: ((target: HostedConversationTarget) => void) | undefined;
}) {
  const router = useRouter();
  const workspaceSlug = useWorkspaceSlug();
  const target = activityOpenTarget(item);
  const link = activityChatLink(workspaceSlug, target);
  const href = router.buildLocation(link).publicHref;
  const unread = item.unreadCount > 0;
  const { place, thread } = item;
  // A channel goes by its name; a DM, and a thread in one, by who is on the other side, whether an
  // Agent or a member.
  const title =
    place.kind === "channel"
      ? place.channelName
      : place.peer.kind === "people" && place.peer.userId === viewerId
        ? m.conversation_dm_self_name({ name: place.peer.displayName })
        : place.peer.displayName;
  // Where a thread is, before its latest reply.
  const placeLabel = place.kind === "channel" ? `#${title}` : `@${title}`;
  const sender =
    item.latest.senderKind === "system" ? m.activity_inbox_system_sender() : item.latest.senderName;

  function handleAction(key: unknown) {
    if (key === "read") actions.read(item);
    else if (key === "unread") actions.unread(item);
    else if (key === "done") actions.done(item);
    else if (key === "unfollow") actions.unfollow(item);
  }

  return (
    // A hairline divides a row from the one above it, from the text column on (past the icon).
    <li className="group relative select-none [-webkit-touch-callout:none] before:pointer-events-none before:absolute before:top-0 before:right-0 before:left-16 before:border-t before:border-secondary first:before:hidden sm:before:left-18">
      {/* The row is a React Aria link so the context menu (`MenuTrigger trigger="contextMenu"`)
          can use it as its trigger; `render` hands the element to TanStack's `Link`, which owns
          navigation. Opening a row reads it, like opening the conversation does. */}
      <Dropdown.Root trigger="contextMenu">
        <AriaLink
          href={href}
          aria-current={current ? "true" : undefined}
          onPress={() => {
            if (unread) actions.read(item);
          }}
          render={(props) =>
            "href" in props ? (
              <Link
                {...props}
                {...link}
                onClick={(event) => {
                  // With room beside the list a plain click (or Enter) opens the row there, so
                  // neither `Link` nor React Aria navigates; a modified or middle click still
                  // opens Chat. React Aria's handler still runs: it ends a keyboard press.
                  const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
                  if (onOpen && event.button === 0 && !modified) {
                    event.preventDefault();
                    onOpen(target);
                  }
                  props.onClick?.(event);
                }}
              />
            ) : (
              <span {...props} />
            )
          }
          className={cn(
            "flex items-center gap-3 px-4 py-3 outline-focus-ring transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 sm:px-6",
            // The row's own hover, kept while the pointer is on its Done check (a sibling).
            current ? "bg-chat-selected-bg" : "group-hover:bg-primary_hover",
          )}
        >
          <ActivityItemIcon item={item} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  "min-w-0 truncate text-md font-semibold",
                  unread ? "text-primary" : "text-secondary",
                )}
              >
                {thread ? <Preview message={thread.root} /> : title}
              </span>
              <ActivityItemBadges item={item} filter={filter} />
              {/* Gives way to the Done check wherever the check shows (hover, focus, the open
                  row); a touch screen has no check, so the time stays. */}
              <RelativeTime
                value={item.latest.createdAt}
                plain
                className={cn(
                  "ml-auto shrink-0 pl-2 font-mono text-xs text-quaternary tabular-nums transition-opacity group-hover:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-0",
                  current && "[@media(hover:hover)]:opacity-0",
                )}
              />
            </span>
            <span className="truncate text-sm text-tertiary">
              {thread && `${placeLabel} · `}
              <span className="font-semibold text-secondary">{sender}: </span>
              <Preview message={item.latest} />
            </span>
          </span>
        </AriaLink>
        <Dropdown.Popover placement="bottom start">
          <Dropdown.Menu aria-label={m.activity_inbox_menu_label()} onAction={handleAction}>
            {unread ? (
              // Keyed by id: React Aria refuses an item whose id changes in place, which happens
              // when a read or unread lands while the menu is still closing.
              <Dropdown.Item
                key="read"
                id="read"
                icon={Mail01}
                label={m.activity_inbox_mark_read()}
                selectionIndicator="none"
              />
            ) : thread ? null : (
              <Dropdown.Item
                key="unread"
                id="unread"
                icon={Mail01}
                label={m.conversation_menu_mark_unread()}
                selectionIndicator="none"
              />
            )}
            <Dropdown.Item
              id="done"
              icon={Check}
              label={m.activity_inbox_menu_done()}
              selectionIndicator="none"
            />
            {thread && place.kind === "channel" && (
              <Dropdown.Item
                id="unfollow"
                icon={BellOff01}
                label={m.conversation_thread_unfollow()}
                selectionIndicator="none"
              />
            )}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
      <ButtonUtility
        icon={Check}
        size="xs"
        color="secondary"
        tooltip={m.activity_inbox_done()}
        aria-label={m.activity_inbox_done()}
        onClick={() => actions.done(item)}
        className={cn(
          "absolute top-1/2 right-3 -translate-y-1/2 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 sm:right-5 [@media(hover:none)]:hidden",
          current ? "opacity-100" : "opacity-0",
        )}
      />
    </li>
  );
});

/**
 * A row's 2.25rem mark: the peer's face for a DM, with Chat's avatar components, otherwise a muted
 * square with the place's glyph (`#` for a channel, a person for a DM), which a thread badges at
 * its corner.
 */
function ActivityItemIcon({ item }: { item: ActivityInboxItem }) {
  const { place, thread } = item;
  if (!thread && place.kind === "direct")
    return place.peer.kind === "agent" ? (
      <LiveAgentAvatar
        agentId={place.peer.agentId}
        name={place.peer.displayName}
        src={place.peer.avatarUrl}
      />
    ) : (
      <MemberAvatar
        size="sm"
        userId={place.peer.userId}
        name={place.peer.displayName}
        src={place.peer.avatarUrl}
      />
    );
  const Glyph = place.kind === "channel" ? Hash01 : User01;
  return (
    <span className="relative flex size-9 shrink-0 items-center justify-center rounded-md bg-tertiary">
      <Glyph aria-hidden="true" className="size-4.5 text-fg-quaternary" />
      {thread && (
        <span className="absolute -right-1 -bottom-1 flex size-4.5 items-center justify-center rounded-full bg-primary ring-1 ring-secondary">
          <MessageTextSquare01 aria-hidden="true" className="size-3 text-fg-tertiary" />
        </span>
      )}
    </span>
  );
}

/** The marks after a row's title: its Task, an unread mention, and how many messages are new. */
function ActivityItemBadges({
  item,
  filter,
}: {
  item: ActivityInboxItem;
  filter: ActivityInboxFilter;
}) {
  const task = item.thread?.task;
  const showMention = filter !== "mentions" && item.unreadMention;
  if (!task && !showMention && item.unreadCount === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {task && (
        <Badge type="color" size="sm" color={TASK_STATUS_COLOR[task.status].badge}>
          #{task.number}
          {task.ownerName ? ` @${task.ownerName}` : ""}
        </Badge>
      )}
      {task?.ownerDeleted && <DeletedAgentBadge />}
      {showMention && (
        <Badge type="color" size="sm" color="brand">
          @{m.activity_inbox_mention_badge()}
        </Badge>
      )}
      {item.unreadCount > 0 && (
        <Badge type="color" size="sm" color="brand">
          {m.activity_inbox_new({ count: item.unreadCount })}
        </Badge>
      )}
    </span>
  );
}

function ActivityInboxEmpty({
  filter,
  onShowAll,
}: {
  filter: ActivityInboxFilter;
  onShowAll: () => void;
}) {
  const title =
    filter === "mentions"
      ? m.activity_inbox_empty_mentions_title()
      : filter === "unread"
        ? m.activity_inbox_empty_unread_title()
        : m.activity_inbox_empty_title();
  const description =
    filter === "mentions"
      ? m.activity_inbox_empty_mentions_description()
      : m.activity_inbox_empty_description();
  return (
    <div className="flex h-full items-center justify-center px-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            {filter === "mentions" ? (
              <AtSign aria-hidden="true" />
            ) : (
              <Activity aria-hidden="true" />
            )}
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        {filter !== "all" && (
          <EmptyContent>
            <Button size="sm" color="secondary" onClick={onShowAll}>
              {m.activity_inbox_show_all()}
            </Button>
          </EmptyContent>
        )}
      </Empty>
    </div>
  );
}

function ActivityInboxLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{m.activity_inbox_load_error()}</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" color="secondary" onClick={onRetry}>
            {m.activity_inbox_retry()}
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}
