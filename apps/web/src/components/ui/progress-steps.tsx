import type { ReactNode } from "react";
import { Check, Loading02 } from "@untitledui/icons";

import { cn } from "#src/lib/utils";

export type ProgressStepStatus = "incomplete" | "current" | "complete";

export type ProgressStepItem = {
  title: ReactNode;
  description?: ReactNode;
  status: ProgressStepStatus;
};

/**
 * A vertical list of steps, each marked done, running, or not started. Untitled UI's own Progress
 * steps are PRO-only, so this composes `@untitledui/icons` with semantic tokens. The running step
 * spins; with reduced motion it shows a still dot instead.
 */
export function ProgressSteps({
  items,
  className,
}: {
  items: ProgressStepItem[];
  className?: string;
}) {
  return (
    <ol className={cn("flex flex-col gap-2 text-sm", className)}>
      {items.map((item, index) => (
        <li
          key={index}
          className="flex items-start gap-2.5"
          aria-current={item.status === "current" ? "step" : undefined}
        >
          <StepMark status={item.status} />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span
              className={cn(
                "font-medium",
                item.status === "incomplete" ? "text-quaternary" : "text-primary",
              )}
            >
              {item.title}
            </span>
            {item.description && <span className="text-tertiary">{item.description}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

function StepMark({ status }: { status: ProgressStepStatus }) {
  if (status === "complete")
    return <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-success-primary" />;
  if (status === "current")
    return (
      <span aria-hidden className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        <Loading02 className="size-4 text-fg-brand-primary motion-safe:animate-spin motion-reduce:hidden" />
        <span className="hidden size-2 rounded-full bg-fg-brand-primary motion-reduce:block" />
      </span>
    );
  return (
    <span aria-hidden className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
      <span className="size-2 rounded-full border border-primary" />
    </span>
  );
}
