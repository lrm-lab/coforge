import type { ReactNode } from "react";

export function DetailGroup({
  heading,
  headingId,
  action,
  children,
}: {
  heading?: ReactNode;
  headingId?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={headingId}>
      {(heading || action) && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 not-last:mb-3">
          {heading && (
            <h2 id={headingId} className="text-sm font-semibold tabular-nums text-primary">
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
