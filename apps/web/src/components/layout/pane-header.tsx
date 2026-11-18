import type { ReactNode } from "react";

import { cx } from "#src/utils/cx";

export type PaneBarAlign = "rule" | "center";

/**
 * The one header every pane uses (conversation, thread, person and Agent profiles, Activity list,
 * Members), so side-by-side panes share their rules (task #136): a 48px title row
 * (`h-pane-title`) and, when `bar` is given, a 38px second row (`h-pane-bar`) for tabs or the
 * pane's own actions. `bar={null}` keeps an empty second row (loading and error states), so the
 * band does not jump when content arrives. `barAlign="rule"` sets underline tabs on the row's
 * bottom rule, letting the active tab's underline stand in for it; `"center"` centres pills.
 */
export function PaneHeader({
  children,
  bar,
  barAlign = "rule",
  className,
  "aria-label": ariaLabel,
}: {
  children: ReactNode;
  bar?: ReactNode;
  barAlign?: PaneBarAlign;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <div data-pane-header className="@container/pane flex shrink-0 flex-col">
      <header
        aria-label={ariaLabel}
        className={cx(
          "flex h-pane-title min-w-0 items-center gap-2 border-b border-secondary md:gap-3",
          className,
        )}
      >
        {children}
      </header>
      {bar !== undefined && (
        <div
          data-pane-bar
          className={cx(
            "relative flex h-pane-bar min-w-0 gap-2 after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-border-secondary *:relative *:z-1",
            barAlign === "rule" ? "items-end" : "items-center",
            className,
          )}
        >
          {bar}
        </div>
      )}
    </div>
  );
}
