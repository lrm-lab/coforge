import type { FC, ReactNode } from "react";
import { LayoutLeft } from "@untitledui/icons";
import type { NavItemType } from "#src/components/application/app-navigation/config";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { MobileNavigationHeader } from "#src/components/layout/sidebar/mobile-header";
import { writeSidebarExpanded } from "#src/features/settings/sidebar-expanded";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";

/** 220px at the default text size; rem so the sidebar grows with the browser's font size. */
export const SIDEBAR_EXPANDED_WIDTH = "13.75rem";

type ExpandedItemType = NavItemType & { icon: FC<{ className?: string }>; current?: boolean };

function ExpandedItem({ href, icon: Icon, label, current, badge }: ExpandedItemType) {
  return (
    <a
      href={href}
      aria-current={current ? "page" : undefined}
      className={cx(
        "group flex h-11 items-center gap-3.5 rounded-lg px-3 text-sm font-medium outline-focus-ring transition-colors duration-100 ease-linear focus-visible:outline-2 focus-visible:outline-offset-2",
        current
          ? "bg-sidebar-item-active font-semibold text-brand-secondary"
          : "bg-sidebar-item text-secondary hover:bg-sidebar-item-active",
      )}
    >
      <Icon
        aria-hidden="true"
        className={cx(
          "size-6 shrink-0 transition-colors duration-100 ease-linear",
          current ? "text-brand-secondary" : "text-tertiary group-hover:text-secondary",
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
  /** The Workspace switcher, under the header. */
  subheader?: ReactNode;
  /** The user card at the bottom — the only Settings entry point. */
  footer: ReactNode;
}

/** Global destinations only; the Chat page owns conversation selection. `onCollapse` adds the
 * header's collapse button, which the mobile drawer does not have. */
function SidebarExpandedPanel({
  activeUrl,
  items,
  subheader,
  footer,
  onCollapse,
}: SidebarExpandedProps & { onCollapse?: () => void }) {
  return (
    // [data-sidebar] retints official components' bg-primary/bg-secondary/etc
    // via src/styles/coforge-theme.css.
    <aside
      data-sidebar
      className="flex h-full w-full max-w-full flex-col bg-sidebar lg:bg-transparent"
    >
      <div className="mt-2 flex h-12 shrink-0 items-center gap-2.5 px-4">
        <img src="/logo.svg" alt="" className="size-7 shrink-0" />
        <span className="text-lg font-bold text-primary">CoForge</span>
        {onCollapse && (
          <ButtonUtility
            icon={LayoutLeft}
            size="sm"
            color="tertiary"
            aria-label={m.navigation_collapse_sidebar()}
            onClick={onCollapse}
            className="-mr-1.5 ml-auto"
          />
        )}
      </div>
      {subheader && <div className="shrink-0 px-2 pt-1">{subheader}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ul className="mt-3 flex flex-col gap-2 px-3">
          {items.map((item) => (
            <li key={item.label}>
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
  <>
    <div className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:flex lg:[.sidebar-collapsed_&]:hidden">
      <div style={{ width: SIDEBAR_EXPANDED_WIDTH }} className="h-full">
        <SidebarExpandedPanel {...props} onCollapse={() => writeSidebarExpanded(false)} />
      </div>
    </div>
    {/* Spacer: the real sidebar is `fixed`, so this reserves its width in flow. */}
    <div
      style={{ paddingLeft: SIDEBAR_EXPANDED_WIDTH }}
      className="invisible hidden lg:sticky lg:top-0 lg:bottom-0 lg:left-0 lg:block lg:[.sidebar-collapsed_&]:hidden"
    />
  </>
);
