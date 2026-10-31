import type { ReactNode } from "react";

/**
 * A detail group: an optional heading over its content on the page itself, with no fill, border
 * or shadow; whitespace separates it from the next. The heading's actions move to a line of their
 * own, left-aligned, when they do not fit beside it, as on Raft's phone layout.
 */
export function DetailGroup({
  heading,
  headingId,
  action,
  children,
}: {
  heading?: string;
  headingId?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={headingId}>
      {(heading || action) && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 not-last:mb-3">
          {heading && (
            <h2 id={headingId} className="text-sm font-semibold text-primary">
              {heading}
            </h2>
          )}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
