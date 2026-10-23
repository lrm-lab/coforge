import type { ReactNode } from "react";

/**
 * The subtle-fill container shared by the detail groups: no border, no
 * shadow, an optional heading inset to the row text, dividers between rows
 * supplied by the child list itself (`dl`/`ul` with `divide-y`).
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
        <div className="mb-2 flex items-center justify-between gap-3 px-4">
          {heading && (
            <h2 id={headingId} className="text-sm font-semibold text-primary">
              {heading}
            </h2>
          )}
          {action}
        </div>
      )}
      <div className="rounded-xl bg-secondary px-4">{children}</div>
    </section>
  );
}

/**
 * One label—value row: label left, value right, on a single line that never
 * wraps. `footer` is an optional full-width block below that line, such as
 * the upgrade slot under the Version row.
 */
export function DetailRow({
  label,
  value,
  footer,
}: {
  label: string;
  value: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="grid min-h-11 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 py-3 @max-md:items-start">
      <dt className="text-sm font-medium whitespace-nowrap text-primary">{label}</dt>
      <dd className="flex min-h-6 min-w-0 flex-wrap items-center justify-end gap-2 text-sm text-tertiary">
        <span className="min-w-0 truncate">{value}</span>
      </dd>
      {footer && <dd className="col-span-2">{footer}</dd>}
    </div>
  );
}
