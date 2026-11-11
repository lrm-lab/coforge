import type { ReactNode } from "react";

import { cn } from "#src/lib/utils";

/**
 * Content that folds shut and opens again: its height closes as it fades, so what is below moves
 * up instead of jumping, and a change of mind mid-way turns it back from where it got to (a CSS
 * transition, not keyframes). It stays mounted, and inert while shut so nothing in it takes focus.
 * Timed by the app's motion tokens; with reduced motion it changes at once.
 */
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
      {/* Clipped with a margin, so a focus ring at its edge still shows; shut, it is transparent. */}
      <div className="min-h-0 overflow-clip [overflow-clip-margin:--spacing(1)]">{children}</div>
    </div>
  );
}
