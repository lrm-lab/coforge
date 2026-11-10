import type { FC, ReactNode } from "react";
import type { NavItemType } from "#src/components/application/app-navigation/config";
import { CoForgeMark } from "#src/components/foundations/logo/coforge-mark";
import { MobileNavigationHeader } from "#src/components/layout/sidebar/mobile-header";
import { cx } from "#src/utils/cx";

/** 192px at the default text size; rem so the sidebar grows with the browser's font size. */
export const SIDEBAR_EXPANDED_WIDTH = "12rem";

type ExpandedItemType = NavItemType & {
  icon: FC<{ className?: string }>;
  current?: boolean;
  /** A heading that starts a new group at this item. */
  groupLabel?: string;
};

function ExpandedItem({ href, icon: Icon, label, current, badge }: ExpandedItemType) {
  return (
    <a
      href={href}
      aria-current={current ? "page" : undefined}
      className={cx(
        "group flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium outline-focus-ring transition-colors duration-100 ease-linear focus-visible:outline-2 focus-visible:outline-offset-2",
        current
          ? "bg-nav-bg-current font-semibold text-nav-fg-current"
          : "text-nav-fg hover:bg-sidebar-item-active hover:text-secondary",
      )}
    >
      <Icon
        aria-hidden="true"
        className={cx(
          "size-5 shrink-0 transition-colors duration-100 ease-linear",
          current ? "text-nav-fg-current" : "text-nav-fg group-hover:text-secondary",
        )}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge}
    </a>
  );
}

interface SidebarExpandedProps {
  activeUrl?: string;
  items: ExpandedItemType[];
  /** The phone drawer's Workspace switcher, in its top row; desktop has it in the top bar. */
  subheader?: ReactNode;
  /** Buttons at the end of the drawer's top row (search). */
  actions?: ReactNode;
  /** What sits at the bottom: What's new, and in the drawer the user's own controls. */
  footer: ReactNode;
}

/** Global destinations only; the Chat page owns conversation selection. */
function SidebarExpandedPanel({
  activeUrl,
  items,
  subheader,
  actions,
  footer,
}: SidebarExpandedProps) {
  return (
    // [data-sidebar] retints official components' bg-primary/bg-secondary/etc
    // via src/styles/coforge-theme.css.
    <aside
      data-sidebar
      className="flex h-full w-full max-w-full flex-col bg-sidebar lg:bg-transparent"
    >
      {/* The phone drawer's own top row; on desktop the window's top bar holds these. One axis for
      the whole column: every icon starts 1.5rem in, every label 3.5rem in. */}
      {subheader && (
        <div className="mt-2 flex h-12 shrink-0 items-center gap-3 pr-3 pl-6">
          <CoForgeMark className="size-5 shrink-0" />
          <div className="flex min-w-0 flex-1">{subheader}</div>
          {actions}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ul className="mt-2 flex flex-col gap-0.5 px-3">
          {items.map((item) => (
            <li key={item.label}>
              {item.groupLabel && (
                <div className="mt-5 mb-1 px-3 text-xs font-medium text-quaternary">
                  {item.groupLabel}
                </div>
              )}
              <ExpandedItem {...item} current={item.href === activeUrl} />
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-auto shrink-0 p-3">{footer}</div>
    </aside>
  );
}

/** The mobile drawer: the same panel, opened from each page's header. */
export const SidebarMobileDrawer = (props: SidebarExpandedProps) => (
  <MobileNavigationHeader>
    <SidebarExpandedPanel {...props} />
  </MobileNavigationHeader>
);

/** The desktop sidebar. Both this and the rail are always rendered; the `sidebar-collapsed` class
 * on <html> (see `features/settings/sidebar-expanded.ts`) decides which one shows, so the markup
 * never depends on the stored preference. */
export const SidebarExpanded = (props: SidebarExpandedProps) => (
  <div className="hidden shrink-0 lg:flex lg:[.sidebar-collapsed_&]:hidden">
    <div style={{ width: SIDEBAR_EXPANDED_WIDTH }} className="h-full">
      <SidebarExpandedPanel {...props} />
    </div>
  </div>
);
