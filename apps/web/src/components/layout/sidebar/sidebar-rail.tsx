import type { FC, ReactNode } from "react";
import { Button as AriaButton, Link as AriaLink } from "react-aria-components";
import type { NavItemType } from "#src/components/application/app-navigation/config";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { TooltipGroup } from "#src/components/ui/tooltip-group";
import { UnreadBadge, UnreadDot } from "#src/components/ui/unread-marker";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";

export const SIDEBAR_RAIL_WIDTH = "3.5rem";

const RAIL_TARGET =
  "group mx-auto flex size-11 items-center justify-center rounded-lg outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2";
const RAIL_TILE =
  "relative flex size-10 items-center justify-center rounded-lg transition-colors duration-100 ease-out";
const RAIL_ICON = "size-5 transition-colors duration-100 ease-out";

type RailItemType = NavItemType & {
  icon: FC<{ className?: string }>;
  current?: boolean;
  unreadCount?: number;
};

function RailItem({ href, icon: Icon, label, current, badge, unreadCount }: RailItemType) {
  return (
    <Tooltip title={label} placement="right" offset={4}>
      <AriaLink
        href={href}
        aria-label={
          unreadCount ? `${label}, ${m.conversation_thread_unread({ count: unreadCount })}` : label
        }
        aria-current={current ? "page" : undefined}
        className={RAIL_TARGET}
      >
        <span
          className={cx(RAIL_TILE, current ? "bg-nav-bg-current" : "group-hover:bg-sidebar-accent")}
        >
          <Icon
            aria-hidden="true"
            className={cx(
              RAIL_ICON,
              current ? "text-nav-fg-current" : "text-nav-fg group-hover:text-secondary",
            )}
          />
          {unreadCount ? (
            <UnreadBadge
              count={unreadCount}
              className="absolute -top-1 -right-1.5 h-4 min-w-4 px-1 ring-2 ring-sidebar"
            />
          ) : badge ? (
            <UnreadDot className="absolute top-1.5 right-1.5" />
          ) : null}
        </span>
      </AriaLink>
    </Tooltip>
  );
}

export function RailButton({
  icon: Icon,
  label,
  tooltip,
  onPress,
  dot = false,
  ...aria
}: {
  icon: FC<{ className?: string }>;
  label: string;
  tooltip?: ReactNode;
  onPress: () => void;
  dot?: boolean;
  "aria-haspopup"?: "dialog";
  "aria-keyshortcuts"?: string;
}) {
  return (
    <Tooltip title={tooltip ?? label} placement="right" offset={4}>
      <AriaButton {...aria} aria-label={label} onPress={onPress} className={RAIL_TARGET}>
        <span className={cx(RAIL_TILE, "group-hover:bg-sidebar-accent")}>
          <Icon
            aria-hidden="true"
            className={cx(RAIL_ICON, "text-nav-fg group-hover:text-secondary")}
          />
          {dot && <UnreadDot className="absolute top-1.5 right-1.5" />}
        </span>
      </AriaButton>
    </Tooltip>
  );
}

interface SidebarRailProps {
  activeUrl?: string;
  items: RailItemType[];
  header: ReactNode;
  footer: ReactNode;
}

export const SidebarRail = ({ activeUrl, items, header, footer }: SidebarRailProps) => (
  <aside
    data-sidebar
    style={{ width: SIDEBAR_RAIL_WIDTH }}
    className="flex h-full max-h-full w-full flex-col overflow-x-hidden overflow-y-auto pb-3"
  >
    <TooltipGroup className="flex min-h-full w-full flex-1 flex-col items-center justify-between">
      <div className="flex w-full flex-col items-center">
        <div className="mt-2 flex flex-col items-center gap-1">{header}</div>
        <ul className="mt-2 flex w-full flex-col gap-1">
          {items.map((item) => (
            <li key={item.label} className="flex w-full min-w-0 justify-center">
              <RailItem {...item} current={item.href === activeUrl} />
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-col items-center gap-2">{footer}</div>
    </TooltipGroup>
  </aside>
);
