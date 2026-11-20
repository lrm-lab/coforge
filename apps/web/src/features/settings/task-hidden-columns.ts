import { TASK_WRITE_STATUSES, type TaskStatus } from "@lrm/coforge-sdk/internal";
import { useCallback } from "react";

import { createDevicePreference } from "./device-preference";

const STORAGE_KEY = "coforge-task-hidden-columns";
const NONE: ReadonlySet<TaskStatus> = new Set();

export const taskColumnHiddenClass = (status: TaskStatus) => `task-column-hidden-${status}`;

export const HIDDEN_COLUMN_CLASS: Record<TaskStatus, string> = {
  backlog: "[.task-column-hidden-backlog_&]:hidden",
  todo: "[.task-column-hidden-todo_&]:hidden",
  in_progress: "[.task-column-hidden-in_progress_&]:hidden",
  in_review: "[.task-column-hidden-in_review_&]:hidden",
  done: "[.task-column-hidden-done_&]:hidden",
  closed: "[.task-column-hidden-closed_&]:hidden",
};

export function parseHiddenColumns(stored: string | null): ReadonlySet<TaskStatus> {
  const names = new Set(stored?.split(",") ?? []);
  return new Set(TASK_WRITE_STATUSES.filter((status) => names.has(status)));
}

export function serializeHiddenColumns(hidden: ReadonlySet<TaskStatus>): string {
  return TASK_WRITE_STATUSES.filter((status) => hidden.has(status)).join(",");
}

export const TASK_HIDDEN_COLUMNS_BOOT = `var taskColumns=localStorage.getItem("${STORAGE_KEY}");if(taskColumns){taskColumns.split(",").forEach(function(status){if(${JSON.stringify(TASK_WRITE_STATUSES)}.indexOf(status)>=0){document.documentElement.classList.add("task-column-hidden-"+status)}})}`;

const preference = createDevicePreference({
  key: STORAGE_KEY,
  parse: parseHiddenColumns,
  serialize: serializeHiddenColumns,
  fallback: NONE,
  apply: (hidden) => {
    for (const status of TASK_WRITE_STATUSES)
      document.documentElement.classList.toggle(taskColumnHiddenClass(status), hidden.has(status));
  },
});

/** Whether a column is hidden now; for effects, which must not wait for a render to know. */
export const isTaskColumnHidden = (status: TaskStatus) => preference.read().has(status);

/** The hidden columns, and how to hide or show one. */
export function useTaskHiddenColumns() {
  const [hidden, setAll] = preference.useValue();
  const setHidden = useCallback(
    (status: TaskStatus, hide: boolean) => {
      const next = new Set(preference.read());
      if (hide) next.add(status);
      else next.delete(status);
      setAll(next);
    },
    [setAll],
  );
  return [hidden, setHidden] as const;
}
