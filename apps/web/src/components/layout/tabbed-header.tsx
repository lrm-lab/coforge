import type { ReactNode } from "react";

import { PaneHeader } from "#src/components/layout/pane-header";

/**
 * A `PaneHeader` with identity on the left and utility actions on the right of the title row, and
 * its tabs in the second row: underline tabs on the rule, or pills (`tabsStart`) centred in it.
 * Without tabs the second row stays, empty, so a header keeps its height while its tabs load.
 * `className` sets the side gutter.
 */
export function TabbedHeader({
  identity,
  actions,
  tabs,
  tabsStart,
  soft,
  className = "px-4 md:px-6",
}: {
  identity: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  tabsStart?: boolean;
  soft?: boolean;
  className?: string;
}) {
  return (
    <PaneHeader
      bar={tabs || null}
      barAlign={tabsStart ? "center" : "rule"}
      className={className}
      soft={soft}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 md:gap-3">{identity}</div>
      {actions && <div className="flex shrink-0 items-center">{actions}</div>}
    </PaneHeader>
  );
}
