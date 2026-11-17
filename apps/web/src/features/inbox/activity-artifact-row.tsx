import { memo } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { Check, Mail01 } from "@untitledui/icons";
import { Link as AriaLink } from "react-aria-components";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { ActorName } from "#src/features/avatars/actor-name";
import { ArtifactIcon } from "#src/features/artifacts/artifact-parts";
import { artifactPageRoute } from "#src/features/artifacts/artifact-search";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { ActivityArtifactItem } from "#src/server/inbox/activity-inbox.server";
import type { ActivityInboxFilter } from "./activity-inbox.schemas";
import { artifactEventLine } from "./activity-artifact-event";
import { ACTIVITY_ROW_ITEM_CLASS, ACTIVITY_ROW_LINK_CLASS } from "./activity-inbox-row";
import {
  ActivityDoneCheck,
  ActivityMentionBadge,
  ActivityRowTime,
  ActivityRowTitle,
  ActivityUnreadCount,
  ActivityUnreadDot,
} from "./activity-row-parts";
import type { ActivityItemActions } from "./use-activity-item-actions";

export const ActivityArtifactRow = memo(function ActivityArtifactRow({
  item,
  filter,
  actions,
  tabStop,
  clock = false,
}: {
  item: ActivityArtifactItem;
  filter: ActivityInboxFilter;
  actions: ActivityItemActions;
  tabStop: boolean;
  clock?: boolean;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const { event, target } = item;
  const unread = item.unreadCount > 0;
  const link = artifactPageRoute(workspaceSlug, item.artifact.id);
  const search = {
    version: target.version ?? undefined,
    review: target.reviewId ?? undefined,
    comment: target.commentId ?? undefined,
  };
  const href = useRouter().buildLocation({ ...link, search }).href;
  return (
    <li
      data-activity-row={item.key}
      data-activity-artifact={item.artifact.id}
      className={cn(ACTIVITY_ROW_ITEM_CLASS, "select-none [-webkit-touch-callout:none]")}
    >
      <Dropdown.Root trigger="contextMenu">
        <AriaLink
          href={href}
          render={(props) =>
            "href" in props ? (
              <Link {...props} {...link} search={search} tabIndex={tabStop ? 0 : -1} />
            ) : (
              <span {...props} />
            )
          }
          className={cn(
            ACTIVITY_ROW_LINK_CLASS,
            "group-hover:bg-primary_hover focus-visible:bg-primary_hover",
          )}
        >
          <ArtifactIcon entryPath={item.artifact.entryPath} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-2">
              {unread && <ActivityUnreadDot />}
              <ActivityRowTitle unread={unread}>{item.artifact.title}</ActivityRowTitle>
              <span className="flex shrink-0 items-center gap-1.5">
                {filter !== "mentions" && item.unreadMention && <ActivityMentionBadge />}
                {unread && <ActivityUnreadCount count={item.unreadCount} />}
              </span>
              <ActivityRowTime value={item.at} clock={clock} current={false} />
            </span>
            <span className="truncate text-sm text-secondary">
              <ActorName actor={event.actor} /> {artifactEventLine(item)}
            </span>
          </span>
        </AriaLink>
        <Dropdown.Popover placement="bottom start">
          <Dropdown.Menu
            aria-label={m.activity_inbox_menu_label()}
            onAction={(key) => (key === "read" ? actions.read(item) : actions.done(item))}
          >
            {unread && (
              <Dropdown.Item
                id="read"
                icon={Mail01}
                label={m.activity_inbox_mark_read()}
                selectionIndicator="none"
              />
            )}
            <Dropdown.Item
              id="done"
              icon={Check}
              label={m.activity_inbox_menu_done()}
              selectionIndicator="none"
            />
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
      <ActivityDoneCheck tabStop={tabStop} current={false} onDone={() => actions.done(item)} />
    </li>
  );
});
