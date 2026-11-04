import type { TaskProjectRef } from "@lrm/coforge-sdk/internal";

export type { TaskProjectRef } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import type { Prisma } from "#src/generated/prisma/client";
import type { Member } from "./task-board-ports.server";

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

/**
 * The Project a `create` files its Tasks under (task #484): the one named; absent, a sub-task's
 * parent's (`parent`, resolved by the caller); else the Project `member` last filed one under
 * here. A direct message has none, and cannot be given one. A person's pick is remembered on
 * their member row for the next create.
 */
export async function resolveNewTaskProject(
  tx: Prisma.TransactionClient,
  scope: { conversationId: string; workspaceId: string },
  member: Member,
  command: { project?: string | null },
  parent: { project?: TaskProjectRef | null } | null,
): Promise<TaskProjectRef | null> {
  const conversation = await tx.conversation.findUniqueOrThrow({
    where: { id: scope.conversationId },
    select: { directKey: true },
  });
  if (command.project !== undefined && (!command.project || conversation.directKey))
    throw new AppError("INVALID_INPUT", {
      errorId: "task-project",
      hint: conversation.directKey
        ? "a direct message's Tasks are not filed under a Project"
        : "--project names a Project by slug",
    });
  const project =
    command.project !== undefined
      ? await resolveTaskProject(tx, scope.workspaceId, command.project!)
      : (parent?.project ?? (member.userId ? (member.lastTaskProject ?? null) : null));
  if (project && member.userId && member.lastTaskProject?.id !== project.id)
    await tx.conversationMember.update({
      where: { id: member.id },
      data: { lastTaskProjectId: project.id },
    });
  return project;
}
