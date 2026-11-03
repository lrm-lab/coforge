import type { ReactNode } from "react";

import { cn } from "#src/lib/utils";

/** One line of the Task popup's property grid: a short label, then its value (or the control that
 * edits it). */
export function TaskProperty({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-8 min-w-0 items-center gap-3",
        // Beside the pages, the label sits above its value, as Jira's Details.
        "[[data-layout=sidebar]_&]:flex-col [[data-layout=sidebar]_&]:items-start [[data-layout=sidebar]_&]:gap-1",
        className,
      )}
    >
      <dt className="w-20 shrink-0 text-sm text-tertiary [[data-layout=sidebar]_&]:w-auto [[data-layout=sidebar]_&]:text-xs">
        {label}
      </dt>
      <dd className="flex min-w-0 flex-1 items-center [[data-layout=sidebar]_&]:w-full">
        {children}
      </dd>
    </div>
  );
}
