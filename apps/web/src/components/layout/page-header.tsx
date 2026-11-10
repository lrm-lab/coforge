import type { FC } from "react";

import { PageBackButton } from "#src/components/layout/page-back-button";
import { TabbedHeader } from "#src/components/layout/tabbed-header";
import { cn } from "#src/lib/utils";

/**
 * The 48px header band every page owns. On a phone it carries the back button, which a tab
 * home (no `leading`, `null`) leaves out.
 *
 * With `tabs` it is the conversation header's row (`TabbedHeader`): title on the left, the tabs
 * centered (or, with `tabsStart`, after it), actions on the right.
 */
export function PageHeader({
  leading,
  icon: Icon,
  heading,
  breadcrumb,
  meta,
  actions,
  tabs,
  tabsStart,
  headingClassName,
}: {
  /** A control that belongs before the title, such as a panel's way back. Left out, a phone gets
   * `PageBackButton`; `null` shows nothing. */
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
  /** Puts the tabs after the title, left-aligned, where they would be centered. */
  tabsStart?: boolean;
  /** For a heading that gives way on a phone, where `meta` carries the page's name. */
  headingClassName?: string;
}) {
  const title = (
    <>
      {leading === undefined ? <PageBackButton /> : leading}
      {Icon && <Icon aria-hidden="true" className="size-5 shrink-0 text-fg-secondary" />}
      {breadcrumb}
      <h1 className={cn("truncate text-lg font-semibold text-primary", headingClassName)}>
        {heading}
      </h1>
      {meta}
    </>
  );
  if (tabs)
    return (
      <TabbedHeader
        identity={title}
        actions={actions && <div className="flex items-center gap-2">{actions}</div>}
        tabs={tabs}
        tabsStart={tabsStart}
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
