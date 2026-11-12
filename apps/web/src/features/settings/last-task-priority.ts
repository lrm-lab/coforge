import { TASK_PRIORITY_LEVELS, type TaskPriorityLevel } from "@lrm/coforge-sdk/internal";

import { createDevicePreference } from "./device-preference";

/**
 * The priority a Task made from a conversation — "Send as task" or "Make task" — starts with:
 * the last level picked on this device (task #12). Only the four levels are ever a choice, so a
 * stored value outside them reads as the fallback.
 */
const preference = createDevicePreference<TaskPriorityLevel>({
  key: "coforge-task-priority",
  parse: (stored) => TASK_PRIORITY_LEVELS.find((level) => level === stored) ?? "medium",
  serialize: (value) => value,
  fallback: "medium",
});

/** The remembered priority, read now — for send paths that are not components. */
export function readLastTaskPriority(): TaskPriorityLevel {
  return preference.read();
}

/** The remembered priority as state, with its setter for the pickers that choose it. */
export function useLastTaskPriority() {
  return preference.useValue();
}
