import type { TaskProjectRef } from "@lrm/coforge-sdk/internal";

export type { TaskProjectRef } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import type { Prisma } from "#src/generated/prisma/client";

/** What a Task's view names of its Project. */
export const TASK_PROJECT_SELECT = {
  id: true,
  name: true,
  slug: true,
} satisfies Prisma.ProjectSelect;

export const taskProjectView = (project: TaskProjectRef): TaskProjectRef => ({
  id: project.id,
  name: project.name,
  slug: project.slug,
});

/**
 * The Project `slug` names in this Workspace. An unknown slug is `INVALID_INPUT` naming it; a
 * Project of another Workspace is the same refusal, never a leak.
 */
export async function resolveTaskProject(
  tx: Pick<Prisma.TransactionClient, "project">,
  workspaceId: string,
  slug: string,
): Promise<TaskProjectRef> {
  const project = await tx.project.findFirst({
    where: { workspaceId, slug },
    select: TASK_PROJECT_SELECT,
  });
  if (!project)
    throw new AppError("INVALID_INPUT", {
      errorId: "task-project-unknown",
      hint: `no project named "${slug}" in this Workspace`,
    });
  return project;
}
