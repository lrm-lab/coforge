import { memo, type Ref } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { Check, Mail01 } from "@untitledui/icons";
import { Link as AriaLink } from "react-aria-components";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Fold } from "#src/components/ui/fold";
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
  ActivityRowStatus,
  ActivityRowTime,
  ActivityRowTitle,
  ActivityUnreadDot,
  useActivityRowShortcuts,
} from "./activity-row-parts";
import type { ActivityItemActions } from "./use-activity-item-actions";

export const ActivityArtifactRow = memo(function ActivityArtifactRow({
  item,
  filter,
  actions,
  tabStop,
  clock = false,
  leaving = false,
  ref,
}: {
  item: ActivityArtifactItem;
  filter: ActivityInboxFilter;
  actions: ActivityItemActions;
  tabStop: boolean;
  clock?: boolean;
  leaving?: boolean;
  ref?: Ref<HTMLLIElement>;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const { read: readShortcut, done: doneShortcut } = useActivityRowShortcuts();
  const { event, target } = item;
  const unread = item.unreadCount > 0;
  const showMention = filter !== "mentions" && item.unreadMention;
  const link = artifactPageRoute(workspaceSlug, item.artifact.id);
  const search = {
    version: target.version ?? undefined,
    review: target.reviewId ?? undefined,
    comment: target.commentId ?? undefined,
  };
  const href = useRouter().buildLocation({ ...link, search }).href;
  return (
    <li
      ref={ref}
      data-activity-row={leaving ? undefined : item.key}
      data-activity-artifact={leaving ? undefined : item.artifact.id}
    >
      <Fold open={!leaving} variant="dismiss">
        <div className="pb-0.5">
          <div className={cn(ACTIVITY_ROW_ITEM_CLASS, "select-none [-webkit-touch-callout:none]")}>
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
                <span className="relative flex shrink-0">
                  <ArtifactIcon entryPath={item.artifact.entryPath} />
                  {unread && <ActivityUnreadDot />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="flex min-w-0 flex-1">
                      <ActivityRowTitle unread={unread}>{item.artifact.title}</ActivityRowTitle>
                    </span>
                    <ActivityRowTime value={item.at} clock={clock} current={false} />
                  </span>
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-sm",
                        unread ? "text-tertiary" : "text-quaternary",
                      )}
                    >
                      <ActorName inline actor={event.actor} /> {artifactEventLine(item)}
                    </span>
                    <ActivityRowStatus mention={showMention} unreadCount={item.unreadCount} />
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
                      shortcut={readShortcut}
                      selectionIndicator="none"
                    />
                  )}
                  <Dropdown.Item
                    id="done"
                    icon={Check}
                    label={m.activity_inbox_menu_done()}
                    shortcut={doneShortcut}
                    selectionIndicator="none"
                  />
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown.Root>
            <ActivityDoneCheck
              tabStop={tabStop}
              current={false}
              onDone={() => actions.done(item)}
            />
          </div>
        </div>
      </Fold>
    </li>
  );
});
