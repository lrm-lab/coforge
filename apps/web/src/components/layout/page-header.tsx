import type { FC } from "react";

import { PageBackButton } from "#src/components/layout/page-back-button";
import { PageBreadcrumbs, type BreadcrumbItem } from "#src/components/layout/page-breadcrumbs";
import { PANE_HEADER_ATTR, PANE_HEADER_CLASS } from "#src/components/layout/pane-header";
import { TabbedHeader } from "#src/components/layout/tabbed-header";
import { cn } from "#src/lib/utils";
import { cx } from "#src/utils/cx";

export function PageHeader({
  leading,
  icon: Icon,
  heading,
  breadcrumb,
  breadcrumbs,
  breadcrumbLabel,
  meta,
  actions,
  tabs,
  headingClassName,
}: {
  leading?: React.ReactNode;
  icon?: FC<{ className?: string }>;
  heading: string;
  breadcrumb?: React.ReactNode;
  breadcrumbs?: readonly BreadcrumbItem[];
  breadcrumbLabel?: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  tabs?: React.ReactNode;
  headingClassName?: string;
}) {
  const hasBreadcrumbs = Boolean(breadcrumbs && breadcrumbs.length > 0);
  const title = (
    <>
      {leading === undefined ? <PageBackButton /> : leading}
      {hasBreadcrumbs && breadcrumbs ? (
        <PageBreadcrumbs
          items={breadcrumbs}
          current={heading}
          currentIcon={Icon}
          headingClassName={headingClassName}
          ariaLabel={breadcrumbLabel}
        />
      ) : (
        <>
          {Icon && <Icon aria-hidden="true" className="size-5 shrink-0 text-fg-secondary" />}
          {breadcrumb}
          <h1 className={cn("truncate text-lg font-semibold text-primary", headingClassName)}>
            {heading}
          </h1>
        </>
      )}
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
    <header {...PANE_HEADER_ATTR} className={cx(PANE_HEADER_CLASS, "gap-3 px-page")}>
      {title}
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
