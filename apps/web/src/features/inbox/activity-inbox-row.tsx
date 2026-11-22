import { channelGlyph, ChannelTitle } from "#src/features/conversations/channel-name";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { ActorName } from "#src/features/avatars/actor-name";
import {
  ActivityDoneCheck,
  ActivityMentionBadge,
  ActivityRowTime,
  ActivityRowTitle,
  ActivityUnreadCount,
  ActivityUnreadDot,
  NARROW_HIDDEN,
} from "./activity-row-parts";
import { memo, useRef, type Ref } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { BellOff01, Check, Hash01, Mail01 } from "@untitledui/icons";
import { Link as AriaLink } from "react-aria-components";

import { Badge } from "#src/components/base/badges/badges";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { rememberSharedRect } from "#src/lib/shared-element-rect";
import { collageLayout } from "#src/features/conversations/collage-layout";
import { GroupAvatar } from "#src/features/conversations/group-avatar";
import { MessagePreview } from "#src/features/conversations/message-preview";
import { actionCardPreviewText } from "#src/features/conversations/action-card-preview";
import { systemNoticeText } from "#src/features/conversations/system-notice-text";
import { taskStatusColor } from "#src/features/tasks/task-workflow";
import { cn } from "#src/lib/utils";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import type { HostedConversationTarget } from "#src/features/conversations/conversation-page-search";
import { m } from "#src/paraglide/messages";
import type { ActivityConversationItem } from "#src/server/inbox/activity-inbox.server";
import type { ActivityInboxFilter } from "./activity-inbox.schemas";
import { activityChatLink, activityOpenTarget } from "./activity-open-target";
import { activityRowPlace } from "./activity-row-place";
import type { ActivityItemActions } from "./use-activity-item-actions";

export const ACTIVITY_ROW_ITEM_CLASS =
  "group relative before:pointer-events-none before:absolute before:top-0 before:right-0 before:left-[calc(var(--page-gutter)+3.125rem)] before:border-t before:border-secondary first:before:hidden";

export const ACTIVITY_ROW_LINK_CLASS =
  "flex items-center gap-3 px-page py-3 outline-focus-ring transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2";

function Preview({ message }: { message: ActivityConversationItem["latest"] }) {
  if (message.system) return <>{systemNoticeText(message)}</>;
  const cardText = actionCardPreviewText(message.card);
  if (cardText) return <>{cardText}</>;
  if (message.body) return <MessagePreview body={message.body} mentions={message.mentions} />;
  if (message.forwarded?.[0])
    return <>{m.message_forward_preview({ text: message.forwarded[0].sourceBody })}</>;
  return <>{message.attachments[0]?.fileName ?? ""}</>;
}

export const ActivityInboxRow = memo(function ActivityInboxRow({
  item,
  filter,
  actions,
  viewerId,
  current,
  tabStop,
  onOpen,
  clock = false,
  ref,
}: {
  item: ActivityConversationItem;
  filter: ActivityInboxFilter;
  actions: ActivityItemActions;
  viewerId: string;
  current: boolean;
  tabStop: boolean;
  onOpen: (target: HostedConversationTarget) => void;
  clock?: boolean;
  ref?: Ref<HTMLLIElement>;
}) {
  const router = useRouter();
  const workspaceSlug = useWorkspaceSlug();
  const iconRef = useRef<HTMLSpanElement>(null);
  const titleRef = useRef<HTMLSpanElement>(null);
  const target = activityOpenTarget(item);
  const link = activityChatLink(workspaceSlug, target);
  const href = router.buildLocation(link).publicHref;
  const unread = item.unreadCount > 0;
  const time = <ActivityRowTime value={item.latest.createdAt} clock={clock} current={current} />;
  const { place, thread, task } = item;
  const title =
    place.kind === "channel"
      ? place.channelName
      : place.peer.kind === "people" && place.peer.userId === viewerId
        ? m.conversation_dm_self_name({ name: place.peer.displayName })
        : place.peer.displayName;
  const rowPlace = activityRowPlace(item);
  const placeLabel =
    rowPlace?.kind === "attachment" ? (
      m.activity_inbox_attachment_comment({ fileName: rowPlace.fileName })
    ) : rowPlace && place.kind === "channel" ? (
      <ChannelTitle
        name={title}
        visibility={place.visibility}
        hash={false}
        lockClassName="size-3.5"
      />
    ) : (
      rowPlace && (place.kind === "direct" && place.peer.kind === "agent" ? `@${title}` : title)
    );
  const { latest } = item;
  const sender =
    latest.senderKind === "system" ? (
      m.activity_inbox_system_sender()
    ) : (
      <ActorName
        actor={{
          kind: latest.senderKind,
          id: latest.senderKind === "agent" ? latest.senderAgentId : latest.senderUserId,
          name: latest.senderName,
          avatarUrl: latest.senderAvatarUrl,
          deleted: latest.senderDeleted,
        }}
      />
    );

  function handleAction(key: unknown) {
    if (key === "read") actions.read(item);
    else if (key === "unread") actions.unread(item);
    else if (key === "done") actions.done(item);
    else if (key === "unfollow") actions.unfollow(item);
  }

  return (
    <li
      ref={ref}
      data-activity-row={item.key}
      className={cn(ACTIVITY_ROW_ITEM_CLASS, "select-none [-webkit-touch-callout:none]")}
    >
      <Dropdown.Root trigger="contextMenu">
        <AriaLink
          href={href}
          aria-current={current ? "true" : undefined}
          onPress={(event) => {
            const readByPane = !current && !item.task && !item.mentionAction && !isModified(event);
            if (unread && !readByPane) actions.read(item);
          }}
          render={(props) =>
            "href" in props ? (
              <Link
                {...props}
                {...link}
                tabIndex={tabStop ? 0 : -1}
                onClick={(event) => {
                  if (event.button === 0 && !isModified(event)) {
                    event.preventDefault();
                    if (iconRef.current) rememberSharedRect("activity-row-avatar", iconRef.current);
                    if (titleRef.current)
                      rememberSharedRect("activity-row-title", titleRef.current);
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
            ACTIVITY_ROW_LINK_CLASS,
            current
              ? "bg-chat-selected-bg"
              : "group-hover:bg-primary_hover focus-visible:bg-primary_hover",
          )}
        >
          <span ref={iconRef} className="flex shrink-0">
            <ActivityItemIcon item={item} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-2">
              {unread && <ActivityUnreadDot />}
              <span ref={titleRef} className="flex min-w-0">
                <ActivityRowTitle unread={unread}>
                  {task ? (
                    task.title
                  ) : thread ? (
                    <Preview message={thread.root} />
                  ) : place.kind === "channel" ? (
                    <ChannelTitle name={title} visibility={place.visibility} hash={false} />
                  ) : (
                    title
                  )}
                </ActivityRowTitle>
              </span>
              <ActivityItemBadges item={item} filter={filter} />
              {time}
            </span>
            <span className={cn("truncate text-sm", unread ? "text-secondary" : "text-quaternary")}>
              {placeLabel && <>{placeLabel} · </>}
              {sender}: <Preview message={item.latest} />
            </span>
          </span>
        </AriaLink>
        <Dropdown.Popover placement="bottom start">
          <Dropdown.Menu aria-label={m.activity_inbox_menu_label()} onAction={handleAction}>
            {unread ? (
              <Dropdown.Item
                key="read"
                id="read"
                icon={Mail01}
                label={m.activity_inbox_mark_read()}
                selectionIndicator="none"
              />
            ) : thread || task ? null : (
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
            {(task || (thread && place.kind === "channel")) && (
              <Dropdown.Item
                id="unfollow"
                icon={BellOff01}
                label={task ? m.tasks_unfollow() : m.conversation_thread_unfollow()}
                selectionIndicator="none"
              />
            )}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
      <ActivityDoneCheck tabStop={tabStop} current={current} onDone={() => actions.done(item)} />
    </li>
  );
});

export function ActivityItemIcon({ item }: { item: ActivityConversationItem }) {
  const { place } = item;
  if (place.kind === "direct")
    return place.peer.kind === "agent" ? (
      <ActorAvatar
        size="sm"
        presence
        agentId={place.peer.agentId}
        name={place.peer.displayName}
        src={place.peer.avatarUrl}
      />
    ) : (
      <ActorAvatar
        presence
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
  const Glyph = place.kind === "channel" ? channelGlyph(place) : Hash01;
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-tertiary">
      <Glyph aria-hidden="true" className="size-4.5 text-fg-quaternary" />
    </span>
  );
}

function ActivityItemBadges({
  item,
  filter,
}: {
  item: ActivityConversationItem;
  filter: ActivityInboxFilter;
}) {
  const task = item.thread?.task;
  const showMention = filter !== "mentions" && item.unreadMention;
  if (!task && !item.task && !showMention && item.unreadCount === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {item.task && (
        <Badge type="color" size="sm" color="gray">
          #{item.task.number}
        </Badge>
      )}
      {task && (
        <Badge type="color" size="sm" color={taskStatusColor(task.status).badge}>
          #{task.number}
          {task.ownerName ? (
            <span className={cn(NARROW_HIDDEN, "ml-1")}>
              <ActorName
                actor={{
                  kind: task.ownerFace?.kind ?? "user",
                  id: task.ownerFace?.id,
                  name: task.ownerName,
                  avatarUrl: task.ownerFace?.avatarUrl,
                  deleted: task.ownerDeleted,
                }}
              />
            </span>
          ) : null}
        </Badge>
      )}
      {showMention && <ActivityMentionBadge />}
      {item.unreadCount > 0 && <ActivityUnreadCount count={item.unreadCount} />}
    </span>
  );
}

function isModified(event: {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}) {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}
