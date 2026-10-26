import { memo } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { BellOff01, Check, Hash01, Mail01 } from "@untitledui/icons";
import { Link as AriaLink } from "react-aria-components";

import { Badge } from "#src/components/base/badges/badges";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { RelativeTime } from "#src/components/ui/relative-time";
import { collageLayout } from "#src/features/conversations/collage-layout";
import { GroupAvatar } from "#src/features/conversations/group-avatar";
import { MessagePreview } from "#src/features/conversations/message-preview";
import { TASK_STATUS_COLOR } from "#src/features/tasks/task-workflow";
import { cn } from "#src/lib/utils";
import { DeletedAgentBadge } from "#src/features/agents/deleted-agent";
import { LiveAgentAvatar } from "#src/features/agents/live-agent-avatar";
import { MemberAvatar } from "#src/features/workspaces/member-avatar";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import type { HostedConversationTarget } from "#src/features/conversations/conversation-page-search";
import { m } from "#src/paraglide/messages";
import type { ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";
import type { ActivityInboxFilter } from "./activity-inbox.schemas";
import { activityChatLink, activityOpenTarget } from "./activity-open-target";
import type { ActivityItemActions } from "./use-activity-item-actions";

/** A message's text rendered as inline Markdown, or its first attachment's name. */
function Preview({ message }: { message: ActivityInboxItem["latest"] }) {
  if (message.body) return <MessagePreview body={message.body} mentions={message.mentions} />;
  return <>{message.attachments[0]?.fileName ?? ""}</>;
}

export const ActivityInboxRow = memo(function ActivityInboxRow({
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
  /** Opens the row's conversation on the page. */
  onOpen: (target: HostedConversationTarget) => void;
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
    // A hairline divides a row from the one above it, from the text column on: past the gutter,
    // the 2.375rem icon and the 0.75rem gap.
    <li className="group relative select-none [-webkit-touch-callout:none] before:pointer-events-none before:absolute before:top-0 before:right-0 before:left-[calc(var(--page-gutter)+3.125rem)] before:border-t before:border-secondary first:before:hidden">
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
                  // A plain click (or Enter) opens the row on the page, so neither `Link` nor
                  // React Aria navigates; a modified or middle click still opens Chat. React
                  // Aria's handler still runs: it ends a keyboard press.
                  const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
                  if (event.button === 0 && !modified) {
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
            "flex items-center gap-3 px-page py-3 outline-focus-ring transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2",
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
          "absolute top-1/2 right-[calc(var(--page-gutter)-0.25rem)] -translate-y-1/2 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:hidden",
          current ? "opacity-100" : "opacity-0",
        )}
      />
    </li>
  );
});

/**
 * A row's mark, the size of Chat's message avatar: the peer's face for a DM and a thread in one,
 * with Chat's avatar components (the row is named by that peer too); a channel's group avatar (its
 * members' collage, as on the Chat sidebar's row); otherwise, for a channel with no members, a
 * muted square with `#`.
 */
export function ActivityItemIcon({ item }: { item: ActivityInboxItem }) {
  const { place } = item;
  if (place.kind === "direct")
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
  if (place.kind === "channel" && collageLayout(place.members.length).length > 0)
    return (
      <span className="flex shrink-0">
        <GroupAvatar members={place.members} className="avatar-group-sm" />
      </span>
    );
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-tertiary">
      <Hash01 aria-hidden="true" className="size-4.5 text-fg-quaternary" />
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
