import type { ReactNode } from "react";

import { cn } from "#src/lib/utils";

/** One line of the Task popup's property grid: a short label, then its value (or the control that
 * edits it). */
export function TaskProperty({
  label,
  children,
  className,
  labelInChip = false,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  /** As a chip, still say what it is: a relation's value is just another Task's name. */
  labelInChip?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-h-8 min-w-0 items-center gap-3",
        // Beside the pages, the label sits above its value, as Jira's Details.
        "[[data-layout=sidebar]_&]:flex-col [[data-layout=sidebar]_&]:items-start [[data-layout=sidebar]_&]:gap-1",
        // On a phone each property is a chip in one row: its value alone, the label for readers.
        "[[data-layout=chips]_&]:min-h-7 [[data-layout=chips]_&]:shrink-0 [[data-layout=chips]_&]:gap-0 [[data-layout=chips]_&]:rounded-full [[data-layout=chips]_&]:px-2.5 [[data-layout=chips]_&]:text-xs [[data-layout=chips]_&]:ring-1 [[data-layout=chips]_&]:ring-secondary [[data-layout=chips]_&]:ring-inset",
        className,
      )}
    >
      <dt
        className={cn(
          "w-20 shrink-0 text-sm text-tertiary [[data-layout=sidebar]_&]:w-auto [[data-layout=sidebar]_&]:text-xs",
          labelInChip
            ? "[[data-layout=chips]_&]:mr-1.5 [[data-layout=chips]_&]:w-auto [[data-layout=chips]_&]:text-xs"
            : "[[data-layout=chips]_&]:sr-only",
        )}
      >
        {label}
      </dt>
      <dd className="flex min-w-0 flex-1 items-center [[data-layout=chips]_&]:flex-none [[data-layout=sidebar]_&]:w-full">
        {children}
      </dd>
    </div>
  );
}
