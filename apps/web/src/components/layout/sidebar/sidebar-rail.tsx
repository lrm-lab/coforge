import type { FC, ReactNode } from "react";
import { LayoutLeft } from "@untitledui/icons";
import { Pressable } from "react-aria-components";
import type { NavItemType } from "#src/components/application/app-navigation/config";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { UnreadDot } from "#src/components/ui/unread-marker";
import { writeSidebarExpanded } from "#src/features/settings/sidebar-expanded";
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

type RailItemType = NavItemType & { icon: FC<{ className?: string }>; current?: boolean };

/** Icon only. The caption used to live under the icon; the name is now the tooltip. */
function RailItem({ href, icon: Icon, label, current, badge }: RailItemType) {
  return (
    <Tooltip title={label} placement="right" offset={4}>
      <Pressable>
        <a
          href={href}
          aria-label={label}
          aria-current={current ? "page" : undefined}
          className="group mx-auto flex size-11 items-center justify-center rounded-lg outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <span
            className={cx(
              "relative flex size-10 items-center justify-center rounded-lg transition-colors duration-100 ease-linear",
              current ? "bg-sidebar-accent" : "group-hover:bg-sidebar-accent",
            )}
          >
            <Icon
              aria-hidden="true"
              className={cx(
                "size-5 stroke-[2.4] transition-colors duration-100 ease-linear",
                current ? "text-brand-secondary" : "text-nav-icon group-hover:text-secondary",
              )}
            />
            {badge ? <UnreadDot className="absolute top-1.5 right-1.5" /> : null}
          </span>
        </a>
      </Pressable>
    </Tooltip>
  );
}

interface SidebarRailProps {
  activeUrl?: string;
  items: RailItemType[];
  /** Compact workspace switcher, in the top 48px band. */
  subheader?: ReactNode;
  /** Avatar + user menu at the bottom — the only Settings entry point. */
  footer: ReactNode;
}

export const SidebarRail = ({ activeUrl, items, subheader, footer }: SidebarRailProps) => {
  const rail = (
    // [data-sidebar] retints official components' bg-primary/bg-secondary/etc
    // via src/styles/coforge-theme.css.
    <aside
      data-sidebar
      style={{ width: SIDEBAR_RAIL_WIDTH }}
      className="flex h-full max-h-full w-full flex-col items-center justify-between overflow-x-hidden overflow-y-auto pb-4"
    >
      <div className="flex w-full flex-col items-center gap-3">
        <div className="mt-2 flex h-12 shrink-0 items-center justify-center">
          <ButtonUtility
            icon={LayoutLeft}
            size="sm"
            color="tertiary"
            tooltip={m.navigation_expand_sidebar()}
            tooltipPlacement="right"
            aria-label={m.navigation_expand_sidebar()}
            onClick={() => writeSidebarExpanded(true)}
          />
        </div>
        <div className="flex h-10 shrink-0 items-center justify-center">{subheader}</div>
        <ul className="flex w-full flex-col gap-1">
          {items.map((item) => (
            <li key={item.label} className="flex w-full min-w-0 justify-center">
              <RailItem {...item} current={item.href === activeUrl} />
            </li>
          ))}
        </ul>
      </div>
      {footer}
    </aside>
  );

  return (
    <>
      <div className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:flex lg:[html:not(.sidebar-collapsed)_&]:hidden">
        {rail}
      </div>
      {/* Spacer: the real aside is `fixed`, so this reserves its width in flow. */}
      <div
        style={{ paddingLeft: SIDEBAR_RAIL_WIDTH }}
        className="invisible hidden lg:sticky lg:top-0 lg:bottom-0 lg:left-0 lg:block lg:[html:not(.sidebar-collapsed)_&]:hidden"
      />
    </>
  );
};
