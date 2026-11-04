import { cn } from "#src/lib/utils";

/**
 * How far a Task's sub-tasks are, as a ring that fills as they finish: Linear's sub-issue progress
 * ("Sub-issues ◌ 0/7", linear.app/docs/parent-and-sub-issues). Grey until done, then green.
 */
export function SubtaskProgressRing({
  finished,
  total,
  className,
}: {
  finished: number;
  total: number;
  className?: string;
}) {
  const share = finished / Math.max(total, 1);
  const done = total > 0 && finished >= total;
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={cn("shrink-0 -rotate-90", className)}>
      <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2" className="stroke-border-primary" />
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        strokeWidth="2"
        pathLength={100}
        strokeDasharray={`${share * 100} 100`}
        strokeLinecap="round"
        className={done ? "stroke-fg-success-secondary" : "stroke-fg-tertiary"}
      />
    </svg>
  );
}
