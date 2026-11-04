import type { Prisma } from "#src/generated/prisma/client";

/** What a Task's view names of its Project. A leaf on purpose: `task-view.server.ts` reads it at
 * module top level, so it can never come from a module that imports the view back (task #484). */
export const TASK_PROJECT_SELECT = {
  id: true,
  name: true,
  slug: true,
} satisfies Prisma.ProjectSelect;
