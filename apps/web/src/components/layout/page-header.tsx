import type { FC } from "react";

import { MobileNavigationButton } from "#src/components/layout/sidebar/mobile-header";
import { TabbedHeader } from "#src/components/layout/tabbed-header";

/**
 * The 48px header band every page owns. On mobile it carries the drawer button.
 *
 * With `tabs` it is the conversation header's row (`TabbedHeader`): title on the left, the tabs
 * centered, actions on the right.
 */
export function PageHeader({
  leading,
  icon: Icon,
  heading,
  breadcrumb,
  meta,
  actions,
  tabs,
}: {
  /** A control that belongs before the title, such as a panel's way back. */
  leading?: React.ReactNode;
  /** The icon that goes with the heading, shown before it. */
  icon?: FC<{ className?: string }>;
  heading: string;
  /** On subpages, the trail's earlier crumbs plus the separator into the heading: the heading
   * itself is the trail's last crumb (Settings → Account › Change avatar). */
  breadcrumb?: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  /** Underline tabs that switch the page's view. */
  tabs?: React.ReactNode;
}) {
  const title = (
    <>
      {leading ?? <MobileNavigationButton />}
      {Icon && <Icon aria-hidden="true" className="size-5 shrink-0 text-fg-secondary" />}
      {breadcrumb}
      <h1 className="truncate text-lg font-semibold text-primary">{heading}</h1>
      {meta}
    </>
  );
  if (tabs)
    return (
      <TabbedHeader
        identity={title}
        actions={actions && <div className="flex items-center gap-2">{actions}</div>}
        tabs={tabs}
        className="px-page"
      />
    );
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-secondary px-page">
      {title}
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
