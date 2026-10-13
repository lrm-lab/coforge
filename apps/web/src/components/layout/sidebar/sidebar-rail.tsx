import type { FC, ReactNode } from "react";
import { LayoutLeft } from "@untitledui/icons";
import type { NavItemType } from "#src/components/application/app-navigation/config";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { UnreadDot } from "#src/components/ui/unread-marker";
import { writeSidebarExpanded } from "#src/features/settings/sidebar-expanded";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";

// Adapted from Untitled's sidebar-slim.tsx (MIT; docs/design/official-components.md §7) —
// the demo hardcodes Untitled's own logo/account card with no override
// props. The rail is the collapsed desktop sidebar; the expanded one is `sidebar-expanded.tsx`.

/** 80px at the default text size; rem so the rail grows with the browser's font size. */
export const SIDEBAR_RAIL_WIDTH = "5rem";

type RailItemType = NavItemType & { icon: FC<{ className?: string }>; current?: boolean };

/** Without its caption (Settings → Show labels in the sidebar off) an item is just its icon box,
 * so the icons sit close together instead of keeping the captioned spacing. */
function RailItem({ href, icon: Icon, label, current, badge }: RailItemType) {
  return (
    <a
      href={href}
      aria-label={label}
      aria-current={current ? "page" : undefined}
      className="group flex h-18 flex-col items-center justify-center gap-1 rounded-lg px-0.5 [.rail-labels-hidden_&]:h-11 outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2"
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
            "size-5 transition-colors duration-100 ease-linear",
            current ? "text-brand-secondary" : "text-tertiary group-hover:text-secondary",
          )}
        />
        {badge ? <UnreadDot className="absolute top-1.5 right-1.5" /> : null}
      </span>
      <span
        className={cx(
          "text-sm font-medium tracking-normal whitespace-nowrap transition-colors duration-100 ease-linear [.rail-labels-hidden_&]:hidden",
          current
            ? "font-semibold text-brand-secondary"
            : "text-tertiary group-hover:text-secondary",
        )}
      >
        {label}
      </span>
    </a>
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
      className="flex h-full max-h-full flex-col items-center justify-between overflow-y-auto pb-4"
    >
      <div className="flex flex-col items-center gap-3">
        <div className="mt-2 flex h-12 shrink-0 items-center justify-center">
          <ButtonUtility
            icon={LayoutLeft}
            size="sm"
            color="tertiary"
            aria-label={m.navigation_expand_sidebar()}
            onClick={() => writeSidebarExpanded(true)}
          />
        </div>
        <div className="flex h-10 shrink-0 items-center justify-center">{subheader}</div>
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li key={item.label}>
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
