import type { ReactNode } from "react";

import { cn } from "#src/lib/utils";

/**
 * Content that folds shut and opens again: its height closes as it fades, so what is below moves
 * up instead of jumping, and a change of mind mid-way turns it back from where it got to (a CSS
 * transition, not keyframes). It stays mounted, and inert while shut so nothing in it takes focus.
 * Timed by the app's motion tokens; with reduced motion it changes at once. `soft` takes the
 * large tier both ways (250 ms), for a fold big enough that what is below visibly moves with it
 * (an ignored card, Frank task #91), where the quick default reads as a jump.
 */
export function Fold({
  open,
  soft = false,
  className,
  children,
}: {
  open: boolean;
  soft?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      inert={!open}
      data-fold={open ? "open" : "shut"}
      className={cn(
        "grid grid-cols-[minmax(0,1fr)] transition-[grid-template-rows,opacity] motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr] opacity-0",
        soft ? "motion-enter-lg" : open ? "motion-enter" : "motion-leave",
        className,
      )}
    >
      {/* Clipped with a margin, so a focus ring at its edge still shows; shut, it is transparent. */}
      <div className="min-h-0 overflow-clip [overflow-clip-margin:--spacing(1)]">{children}</div>
    </div>
  );
}
