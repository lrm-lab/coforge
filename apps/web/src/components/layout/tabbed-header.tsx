import type { ReactNode } from "react";

import { PaneHeader } from "#src/components/layout/pane-header";

export function TabbedHeader({
  identity,
  actions,
  tabs,
  tabsStart,
  className = "px-4 md:px-6",
}: {
  identity: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  tabsStart?: boolean;
  className?: string;
}) {
  return (
    <PaneHeader
      bar={tabs || undefined}
      barAlign={tabsStart ? "center" : "rule"}
      className={className}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 md:gap-3">{identity}</div>
      {actions && <div className="flex shrink-0 items-center">{actions}</div>}
    </PaneHeader>
  );
}
