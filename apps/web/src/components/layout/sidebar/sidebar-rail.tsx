import type { FC, ReactNode } from "react";
import { Button as AriaButton, Pressable } from "react-aria-components";
import type { NavItemType } from "#src/components/application/app-navigation/config";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { UnreadBadge, UnreadDot } from "#src/components/ui/unread-marker";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";

// Adapted from Untitled's sidebar-slim.tsx (MIT; docs/design/official-components.md §7) —
// the demo hardcodes Untitled's own logo/account card with no override
// props. The rail is the collapsed desktop sidebar; the expanded one is `sidebar-expanded.tsx`.

/**
 * 3.5rem (56px at the default 16px root). The collapsed rail is icons only.
 * The hit target is the 2.75rem icon button, and the name tooltip anchors to
 * that button, not the rail edge. 5rem still left a gutter that pushed the
 * tooltip away from the icon once the caption was gone.
 */
export const SIDEBAR_RAIL_WIDTH = "3.5rem";

// The rail's icon: a 2.75rem hit target around a 2.5rem tile, shared by its links and buttons.
const RAIL_TARGET =
  "group mx-auto flex size-11 items-center justify-center rounded-lg outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2";
const RAIL_TILE =
  "relative flex size-10 items-center justify-center rounded-lg transition-colors duration-100 ease-linear";
const RAIL_ICON = "size-5 stroke-[2.4] transition-colors duration-100 ease-linear";

type RailItemType = NavItemType & {
  icon: FC<{ className?: string }>;
  current?: boolean;
  /** The number on the icon's corner; without it a `badge` is the dot. */
  unreadCount?: number;
};

/** Icon only. The caption used to live under the icon; the name is now the tooltip. */
function RailItem({ href, icon: Icon, label, current, badge, unreadCount }: RailItemType) {
  return (
    <Tooltip title={label} placement="right" offset={4}>
      <Pressable>
        <a
          href={href}
          aria-label={
            unreadCount
              ? `${label}, ${m.conversation_thread_unread({ count: unreadCount })}`
              : label
          }
          aria-current={current ? "page" : undefined}
          className={RAIL_TARGET}
        >
          <span
            className={cx(
              RAIL_TILE,
              current ? "bg-nav-bg-current" : "group-hover:bg-sidebar-accent",
            )}
          >
            <Icon
              aria-hidden="true"
              className={cx(
                RAIL_ICON,
                current ? "text-nav-fg-current" : "text-nav-fg group-hover:text-secondary",
              )}
            />
            {unreadCount ? (
              // A smaller pill on the corner, ringed in the rail's color, so "99+" leaves the
              // icon readable.
              <UnreadBadge
                count={unreadCount}
                className="absolute -top-1 -right-1.5 h-4 min-w-4 px-1 ring-2 ring-sidebar"
              />
            ) : badge ? (
              <UnreadDot className="absolute top-1.5 right-1.5" />
            ) : null}
          </span>
        </a>
      </Pressable>
    </Tooltip>
  );
}

/** A rail icon that opens something rather than a page, named by its tooltip; `dot` marks it
 * unread. */
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
  /** The tooltip, when it says more than the name. */
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
  /** What sits above the nav: the expand toggle, the Workspace mark and search. */
  header: ReactNode;
  /** What sits at the bottom: What's new, the bell and the user's avatar. */
  footer: ReactNode;
}

export const SidebarRail = ({ activeUrl, items, header, footer }: SidebarRailProps) => {
  const rail = (
    // [data-sidebar] retints official components' bg-primary/bg-secondary/etc
    // via src/styles/coforge-theme.css.
    <aside
      data-sidebar
      style={{ width: SIDEBAR_RAIL_WIDTH }}
      className="flex h-full max-h-full w-full flex-col items-center justify-between overflow-x-hidden overflow-y-auto pb-3"
    >
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
    </aside>
  );

  return (
    <div className="hidden shrink-0 lg:flex lg:[html:not(.sidebar-collapsed)_&]:hidden">{rail}</div>
  );
};
