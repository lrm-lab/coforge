import type { TaskPriority } from "@lrm/coforge-sdk/internal";

import { cn } from "#src/lib/utils";

const FILLED_BARS: Record<Exclude<TaskPriority, "urgent" | "none">, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * A Task's priority as a mark: three bars, as many filled as it is high, and a filled square with
 * an exclamation mark for urgent, the marks Linear draws its priorities with. Nothing for none.
 */
export function TaskPriorityIcon({
  priority,
  className,
}: {
  priority: TaskPriority;
  className?: string;
}) {
  if (priority === "none") return null;
  if (priority === "urgent")
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" className={cn("size-4 shrink-0", className)}>
        <rect x="1.5" y="1.5" width="13" height="13" rx="3" className="fill-fg-error-secondary" />
        <path d="M8 4.5v4.5" strokeWidth="1.75" strokeLinecap="round" className="stroke-white" />
        <circle cx="8" cy="11.5" r="1" className="fill-white" />
      </svg>
    );
  const filled = FILLED_BARS[priority];
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={cn("size-4 shrink-0", className)}>
      {[0, 1, 2].map((bar) => (
        <rect
          key={bar}
          x={2 + bar * 4.5}
          y={10 - bar * 3.5}
          width="3"
          height={4 + bar * 3.5}
          rx="1"
          className={bar < filled ? "fill-fg-secondary" : "fill-fg-quaternary/40"}
        />
      ))}
    </svg>
  );
}
