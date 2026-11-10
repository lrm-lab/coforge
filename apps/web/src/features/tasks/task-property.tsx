import type { ComponentType, ReactNode } from "react";

import { cn } from "#src/lib/utils";

/** For a chip whose value is chips of its own (labels): no pill around them. */
export const BARE_CHIP =
  "[[data-layout=chips]_&]:max-w-none [[data-layout=chips]_&]:px-0 [[data-layout=chips]_&]:ring-0 [[data-layout=create]_&]:max-w-none [[data-layout=create]_&]:bg-transparent [[data-layout=create]_&]:ring-0 dark:[[data-layout=create]_&]:bg-transparent";

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
        // On a phone each property is a chip in one row: its value alone, the label for readers. A
        // chip is at most 16rem; a longer value (a Project's or a parent's name) truncates in it.
        "[[data-layout=chips]_&]:min-h-7 [[data-layout=chips]_&]:max-w-64 [[data-layout=chips]_&]:shrink-0 [[data-layout=chips]_&]:gap-0 [[data-layout=chips]_&]:rounded-full [[data-layout=chips]_&]:px-2.5 [[data-layout=chips]_&]:text-xs [[data-layout=chips]_&]:ring-1 [[data-layout=chips]_&]:ring-secondary [[data-layout=chips]_&]:ring-inset",
        // In the form that makes a Task each is a block of its own (task #54): a light fill and a
        // hairline, one step lighter again in dark, its trigger filling it.
        "[[data-layout=create]_&]:min-h-8 [[data-layout=create]_&]:max-w-56 [[data-layout=create]_&]:shrink-0 [[data-layout=create]_&]:gap-0 [[data-layout=create]_&]:rounded-lg [[data-layout=create]_&]:bg-secondary [[data-layout=create]_&]:ring-1 [[data-layout=create]_&]:ring-secondary [[data-layout=create]_&]:ring-inset dark:[[data-layout=create]_&]:bg-tertiary",
        className,
      )}
    >
      <dt
        className={cn(
          "w-20 shrink-0 text-sm text-tertiary [[data-layout=sidebar]_&]:w-auto [[data-layout=sidebar]_&]:text-xs",
          labelInChip
            ? "[[data-layout=chips]_&]:mr-1.5 [[data-layout=chips]_&]:w-auto [[data-layout=chips]_&]:text-xs"
            : "[[data-layout=chips]_&]:sr-only",
          "[[data-layout=create]_&]:sr-only",
        )}
      >
        {label}
      </dt>
      <dd className="flex min-w-0 flex-1 items-center [[data-layout=chips]_&]:flex-initial [[data-layout=create]_&]:flex-initial [[data-layout=sidebar]_&]:w-full">
        {children}
      </dd>
    </div>
  );
}

/**
 * A property with no value yet. In the popup it says so ("No priority"); in the form that makes a
 * Task it names the field with its icon instead, as a block to fill in (task #54).
 */
export function UnsetValue({
  icon: Icon,
  text,
  field,
}: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  text: string;
  field: string;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-sm text-tertiary">
      <Icon
        aria-hidden="true"
        className="hidden size-4 shrink-0 text-fg-quaternary [[data-layout=create]_&]:block"
      />
      <span className="truncate [[data-layout=create]_&]:hidden">{text}</span>
      <span className="hidden truncate [[data-layout=create]_&]:inline">{field}</span>
    </span>
  );
}
