import type { FC, ReactNode } from "react";
import type { NavItemType } from "#src/components/application/app-navigation/config";
import { ConversationListResizeHandle } from "#src/features/conversations/conversation-list-resize-handle";
import { SIDEBAR_COLUMN } from "#src/features/conversations/conversation-list-width";
import { cx } from "#src/utils/cx";

const SIDEBAR_WIDTH_CLASS = "w-(--sidebar-width,15rem) min-w-60";

type ExpandedItemType = NavItemType & { icon: FC<{ className?: string }>; current?: boolean };

function ExpandedItem({ href, icon: Icon, label, current, badge }: ExpandedItemType) {
  return (
    <a
      href={href}
      aria-current={current ? "page" : undefined}
      className={cx(
        "group flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium outline-focus-ring transition-colors duration-100 ease-out focus-visible:outline-2 focus-visible:outline-offset-2",
        current
          ? "bg-nav-bg-current font-semibold text-nav-fg-current"
          : "text-nav-fg hover:bg-sidebar-item-active hover:text-secondary",
      )}
    >
      <Icon
        aria-hidden="true"
        className={cx(
          "size-5 shrink-0 transition-colors duration-100 ease-out",
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
  /** The top row: the Workspace switcher and the collapse toggle. */
  header: ReactNode;
  /** Under the top row: the search entry. */
  search: ReactNode;
  /** What sits at the bottom: What's new and the user's own row. */
  footer: ReactNode;
}

/** Global destinations only; the Chat page owns conversation selection. */
function SidebarExpandedPanel({ activeUrl, items, header, search, footer }: SidebarExpandedProps) {
  return (
    <aside data-sidebar className="flex h-full w-full max-w-full flex-col bg-transparent">
      <div className="mt-2 flex h-12 shrink-0 items-center gap-2 pe-3 ps-4.5">{header}</div>
      <div className="shrink-0 px-3 pt-1">{search}</div>
      <div className="scroll-fade-y min-h-0 flex-1 overflow-y-auto scroll-py-6">
        <ul className="mt-3 flex flex-col gap-0.5 px-3">
          {items.map((item) => (
            <li key={item.label}>
              <ExpandedItem {...item} current={item.href === activeUrl} />
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-auto flex shrink-0 flex-col gap-0.5 p-3">{footer}</div>
    </aside>
  );
}

/** The desktop sidebar. Both this and the rail are always rendered; the `sidebar-collapsed` class
 * on <html> (see `features/settings/sidebar-expanded.ts`) decides which one shows, so the markup
 * never depends on the stored preference. */
export const SidebarExpanded = (props: SidebarExpandedProps) => (
  <div className="hidden shrink-0 lg:flex lg:[.sidebar-collapsed_&]:hidden">
    <div className={cx("relative h-full", SIDEBAR_WIDTH_CLASS)}>
      <SidebarExpandedPanel {...props} />
      <ConversationListResizeHandle column={SIDEBAR_COLUMN} />
    </div>
  </div>
);
