import type { ReactNode } from "react";

import { cn } from "#src/lib/utils";

const FITS_ITS_COLUMN_AND_CLIPS_WITH_ROOM_FOR_AN_EDGE_FOCUS_RING =
  "min-h-0 min-w-0 overflow-clip [overflow-clip-margin:--spacing(1)]";

export type FoldVariant = "default" | "dismiss";

export function Fold({
  open,
  variant = "default",
  className,
  children,
}: {
  open: boolean;
  variant?: FoldVariant;
  className?: string;
  children: ReactNode;
}) {
  if (variant === "dismiss") {
    return (
      <div
        inert={!open}
        data-fold={open ? "open" : "shut"}
        data-fold-variant="dismiss"
        className={cn(
          "grid transition-[grid-template-rows] motion-reduce:delay-0 motion-reduce:transition-none",
          open
            ? "grid-rows-[1fr] motion-enter"
            : "grid-rows-[0fr] delay-[50ms] duration-(--duration-sm-out) ease-(--ease-out-strong)",
          className,
        )}
      >
        <div
          className={cn(
            FITS_ITS_COLUMN_AND_CLIPS_WITH_ROOM_FOR_AN_EDGE_FOCUS_RING,
            "transition-[opacity,transform] motion-reduce:transform-none motion-reduce:transition-none",
            open
              ? "translate-x-0 scale-100 opacity-100 motion-enter"
              : "translate-x-2 scale-[0.98] opacity-0 duration-(--duration-card-out) ease-(--ease-in)",
          )}
        >
          {children}
        </div>
      </div>
    );
  }

  return (
    <div
      inert={!open}
      data-fold={open ? "open" : "shut"}
      className={cn(
        "grid transition-[grid-template-rows,opacity] motion-reduce:transition-none",
        open ? "grid-rows-[1fr] motion-enter" : "grid-rows-[0fr] opacity-0 motion-leave",
        className,
      )}
    >
      <div className={FITS_ITS_COLUMN_AND_CLIPS_WITH_ROOM_FOR_AN_EDGE_FOCUS_RING}>{children}</div>
    </div>
  );
}
