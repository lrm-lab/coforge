import type { TaskPriorityLevel, TaskProjectRef } from "@lrm/coforge-sdk/internal";

/** What a new Task is made with: its title, and what else was set before it was created. */
export type TaskDraft = {
  title: string;
  description?: string;
  /** The assignee bound by id (`user:<id>` or `agent:<id>`). */
  assignee?: string;
  /** Label names. */
  labels?: string[];
  /** The new Task's priority, always one of the four levels the form offers (task #12). */
  priority?: TaskPriorityLevel;
  /** A Project by slug, or null for none; absent where the form offers no Project (a sub-task
   * takes its parent's). */
  project?: string | null;
};

/** The new Task form before anything is set. */
export const emptyDraft = () => ({
  title: "",
  description: "",
  assignee: undefined as string | undefined,
  labels: [] as string[],
  priority: undefined as TaskPriorityLevel | undefined,
  /** Undefined until the viewer picks: a Project's board then starts at that Project. */
  project: undefined as TaskProjectRef | null | undefined,
});
