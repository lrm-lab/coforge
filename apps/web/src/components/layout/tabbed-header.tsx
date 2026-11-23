import type { ReactNode } from "react";

import { cx } from "#src/utils/cx";

export function TabbedHeader({
  identity,
  actions,
  tabs,
  tabsStart,
  className,
}: {
  identity: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  tabsStart?: boolean;
  className?: string;
}) {
  return (
    <div className="@container/tabbed-header shrink-0">
      <header
        className={cx(
          "relative grid grid-cols-[minmax(0,1fr)_auto] border-b border-secondary px-4 md:px-6 @lg/tabbed-header:gap-x-5",
          tabs &&
            "before:pointer-events-none before:absolute before:inset-x-0 before:top-[calc(--spacing(12)-1px)] before:border-t before:border-secondary @lg/tabbed-header:before:hidden",
          tabsStart
            ? "@lg/tabbed-header:grid-cols-[auto_minmax(0,1fr)_auto]"
            : "@lg/tabbed-header:grid-cols-[minmax(0,auto)_auto_minmax(max-content,1fr)]",
          className,
        )}
      >
        <div className="col-start-1 row-start-1 flex h-[calc(--spacing(12)-1px)] min-w-0 items-center gap-2 md:gap-3">
          {identity}
        </div>
        {actions && (
          <div className="col-start-2 row-start-1 flex items-center justify-self-end @lg/tabbed-header:col-start-3">
            {actions}
          </div>
        )}
        {tabs && (
          <div
            className={cx(
              "col-span-2 row-start-2 flex min-w-0 max-w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden @lg/tabbed-header:col-span-1 @lg/tabbed-header:col-start-2 @lg/tabbed-header:row-start-1",
              tabsStart
                ? "items-center py-2 @lg/tabbed-header:py-0"
                : "-mb-px items-end pt-2 @lg/tabbed-header:pt-0",
            )}
          >
            {tabs}
          </div>
        )}
      </header>
    </div>
  );
}
