import type { TaskView } from "@lrm/coforge-sdk/internal";

/** The fields a Task view has when it waits for nothing and has no parent or subtasks. */
export const NO_RELATIONS: Pick<TaskView, "blockedBy" | "blocked" | "parent" | "subtasks"> = {
  blockedBy: [],
  blocked: false,
  parent: null,
  subtasks: null,
};
