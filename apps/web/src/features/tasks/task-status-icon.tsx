import type { TaskStatus } from "@lrm/coforge-sdk/internal";

import { BadgeWithIcon } from "#src/components/base/badges/badges";
import type { IconComponentType } from "#src/components/base/badges/badge-types";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

/** One colour per status, shared by the status icon, the board and the task popup: the badge
 * colour, the solid dot, the icon's colour, and the lighter line the popup's history timeline
 * draws between nodes. */
export const TASK_STATUS_COLOR = {
  backlog: {
    badge: "slate",
    dot: "bg-utility-slate-400",
    text: "text-utility-slate-500",
    line: "bg-utility-slate-300",
  },
  todo: {
    badge: "orange",
    dot: "bg-utility-orange-500",
    text: "text-utility-orange-500",
    line: "bg-utility-orange-300",
  },
  in_progress: {
    badge: "blue",
    dot: "bg-utility-blue-500",
    text: "text-utility-blue-500",
    line: "bg-utility-blue-300",
  },
  in_review: {
    badge: "indigo",
    dot: "bg-utility-indigo-500",
    text: "text-utility-indigo-500",
    line: "bg-utility-indigo-300",
  },
  done: {
    badge: "success",
    dot: "bg-utility-green-500",
    text: "text-utility-green-500",
    line: "bg-utility-green-300",
  },
  closed: {
    badge: "gray",
    dot: "bg-utility-neutral-400",
    text: "text-utility-neutral-400",
    line: "bg-utility-neutral-300",
  },
} as const satisfies Record<TaskStatus, { badge: string; dot: string; text: string; line: string }>;

/**
 * A status as a small ring that fills as the work advances, the way Linear draws issue states:
 * To do an open ring, In progress half full, In review three-quarters, Done a filled check,
 * Closed a filled cross. Colours follow `TASK_STATUS_COLOR`, so the icon, the popup's badge and
 * the history timeline agree.
 */
const RING: Record<TaskStatus, { fill: number; mark?: string }> = {
  backlog: { fill: 0 },
  todo: { fill: 0 },
  in_progress: { fill: 0.5 },
  in_review: { fill: 0.75 },
  done: { fill: 1, mark: "M5.2 8.2l1.9 1.9 3.7-3.9" },
  closed: { fill: 1, mark: "M6 6l4 4M10 6l-4 4" },
};
/** The colour set a status draws with: a status this build does not know — a newer server's,
 * met while an older bundle is still live (task #61) — takes To do's neutral set instead of
 * crashing the chip, badge or timeline. */
export const taskStatusColor = (status: TaskStatus) =>
  (TASK_STATUS_COLOR as Record<string, (typeof TASK_STATUS_COLOR)[TaskStatus] | undefined>)[
    status as string
  ] ?? TASK_STATUS_COLOR.todo;

// The inner pie is a circle of radius 3 stroked 6 wide: its dash length is the filled share.
const PIE = 2 * Math.PI * 3;

export function TaskStatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
  // A status this build does not know draws To do's ring and colour, the neutral fallback, until
  // this bundle learns the newer vocabulary (task #61).
  const ring =
    (RING as Record<string, { fill: number; mark?: string } | undefined>)[status as string] ??
    RING.todo;
  const color =
    (TASK_STATUS_COLOR as Record<string, { text: string } | undefined>)[status as string]?.text ??
    TASK_STATUS_COLOR.todo.text;
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className={cn("size-4 shrink-0", color, className)}>
      <circle
        cx="8"
        cy="8"
        r="6"
        fill={ring.mark ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.5"
      />
      {!ring.mark && ring.fill > 0 && (
        <circle
          cx="8"
          cy="8"
          r="3"
          fill="none"
          stroke="currentColor"
          strokeWidth="6"
          strokeDasharray={`${PIE * ring.fill} ${PIE}`}
          transform="rotate(-90 8 8)"
        />
      )}
      {ring.mark && (
        <path
          d={ring.mark}
          fill="none"
          stroke="white"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

/** The status ring as the leading icon of an Untitled UI badge. The ring keeps its own status
 * colour over the badge's icon colour, so it matches the board. */
const ringIcon =
  (status: TaskStatus): IconComponentType =>
  ({ className }) => (
    <TaskStatusIcon status={status} className={cn(className, taskStatusColor(status).text)} />
  );
const STATUS_BADGE_ICON: Record<TaskStatus, IconComponentType> = {
  backlog: ringIcon("backlog"),
  todo: ringIcon("todo"),
  in_progress: ringIcon("in_progress"),
  in_review: ringIcon("in_review"),
  done: ringIcon("done"),
  closed: ringIcon("closed"),
};

export function statusLabel(status: TaskStatus) {
  // A status this build does not know — a newer server's, met while an older bundle is still
  // live — renders as its raw key with To do's neutral ring, instead of crashing the chip
  // (task #61; the newer vocabulary labels it properly).
  const label = (LABELS as Record<string, (() => string) | undefined>)[status as string];
  return (label ?? (() => status as string))();
}

/** The localized status names, by status; a status this build does not know reads as its key. */
const LABELS: Record<TaskStatus, () => string> = {
  backlog: m.tasks_status_backlog,
  todo: m.tasks_status_todo,
  in_progress: m.tasks_status_in_progress,
  in_review: m.tasks_status_in_review,
  done: m.tasks_status_done,
  closed: m.tasks_status_closed,
};

/** A task as `#N` on its status's colour badge, the status ring leading: how a message body shows a
 * task reference. Another conversation's names its conversation too (`label`: `#design:#7`). */
export function TaskNumberBadge({
  number,
  status,
  label,
}: {
  number: number;
  status: TaskStatus;
  label?: string;
}) {
  return (
    <BadgeWithIcon
      type="color"
      size="sm"
      color={taskStatusColor(status).badge}
      iconLeading={
        (STATUS_BADGE_ICON as Record<string, IconComponentType | undefined>)[status as string] ??
        STATUS_BADGE_ICON.todo
      }
      className="inline-flex"
    >
      {label ?? `#${number}`}
    </BadgeWithIcon>
  );
}
