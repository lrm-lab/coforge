import type { ReactNode } from "react";

import { cn } from "#src/lib/utils";

const FITS_ITS_COLUMN_AND_CLIPS_WITH_ROOM_FOR_AN_EDGE_FOCUS_RING =
  "min-h-0 min-w-0 overflow-clip [overflow-clip-margin:--spacing(1)]";

export function Fold({
  open,
  className,
  children,
}: {
  open: boolean;
  className?: string;
  children: ReactNode;
}) {
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
