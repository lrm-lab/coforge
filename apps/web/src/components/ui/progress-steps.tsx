import type { ReactNode } from "react";
import { Check } from "@untitledui/icons";

import { cn } from "#src/lib/utils";

export type ProgressStepStatus = "incomplete" | "current" | "complete";

export type ProgressStepItem = {
  title: ReactNode;
  description?: ReactNode;
  status: ProgressStepStatus;
};

export function ProgressSteps({
  items,
  spinner = false,
  className,
}: {
  items: ProgressStepItem[];
  spinner?: boolean;
  className?: string;
}) {
  return (
    <ol className={cn("flex flex-col text-sm", className)}>
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        return (
          <li
            key={index}
            className="flex items-start gap-2.5"
            aria-current={item.status === "current" ? "step" : undefined}
          >
            <span className="flex flex-col items-center self-stretch">
              <StepMark status={item.status} spinner={spinner} />
              {!isLast && (
                <span aria-hidden className="my-1 min-h-2 w-px flex-1 bg-border-secondary" />
              )}
            </span>
            <span className={cn("flex min-w-0 flex-1 flex-col gap-0.5", !isLast && "pb-3")}>
              <span
                className={cn(
                  item.status === "current"
                    ? "font-medium text-primary"
                    : item.status === "complete"
                      ? "font-normal text-tertiary"
                      : "font-normal text-quaternary",
                )}
              >
                {item.title}
              </span>
              {item.description && (
                <span
                  className={cn(item.status === "current" ? "text-tertiary" : "text-quaternary")}
                >
                  {item.description}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function StepMark({ status, spinner }: { status: ProgressStepStatus; spinner: boolean }) {
  if (status === "complete") {
    return (
      <span
        aria-hidden
        className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-tertiary text-fg-quaternary"
      >
        <Check className="size-2.5 stroke-[2.25]" />
      </span>
    );
  }
  if (status === "current") {
    return (
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className={cn(
          "mt-0.5 size-4 shrink-0 text-fg-primary",
          spinner && "motion-safe:animate-spin",
        )}
      >
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.18"
          strokeWidth="1.5"
        />
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="24 14"
          strokeLinecap="round"
          transform="rotate(-90 8 8)"
        />
      </svg>
    );
  }
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className="mt-0.5 size-4 shrink-0 text-fg-quaternary opacity-65"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeDasharray="2.5 2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
