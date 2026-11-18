import type { ReactNode } from "react";

import { cx } from "#src/utils/cx";

export type PaneBarAlign = "rule" | "center";

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
