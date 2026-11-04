import type { TaskProjectRef } from "@lrm/coforge-sdk/internal";

export type { TaskProjectRef } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import { visibleChannelWhere } from "#src/server/conversations/channel-read-access.server";
import { viewerDirectConversationWhere } from "#src/server/conversations/viewer-direct-conversations.server";
import type { Member } from "./task-board-ports.server";
import { UNFINISHED_TASK_STATUSES } from "./task-view.server";

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
 * here. `project: null` is an explicit none. Only an explicit pick is remembered on the member
 * row — an inherited or defaulted one is not — and an Agent keeps no last-used default.
 */
export async function resolveNewTaskProject(
  tx: Prisma.TransactionClient,
  scope: { conversationId: string; workspaceId: string },
  member: Member,
  command: { project?: string | null },
  parent: { project?: TaskProjectRef | null } | null,
): Promise<TaskProjectRef | null> {
  if (command.project === null) return null;
  if (command.project !== undefined) {
    const project = await resolveTaskProject(tx, scope.workspaceId, command.project);
    await rememberTaskProject(tx, member, project);
    return project;
  }
  if (parent?.project) return parent.project;
  if (!member.userId) return null;
  const lastUsed = await tx.conversationMember.findUniqueOrThrow({
    where: { id: member.id },
    select: { lastTaskProject: { select: TASK_PROJECT_SELECT } },
  });
  return lastUsed.lastTaskProject;
}

/** A person's Task Project pick is remembered on their member row (`create`, `amend`). */
export async function rememberTaskProject(
  tx: Prisma.TransactionClient,
  member: Member,
  project: TaskProjectRef,
) {
  if (member.userId)
    await tx.conversationMember.update({
      where: { id: member.id },
      data: { lastTaskProjectId: project.id },
    });
}
/**
 * Each Project's open-Task count as one reader can see them (task #484): Tasks filed under it in
 * a channel the reader may see, or a direct conversation they are in. Another person's DM, a
 * private channel the reader is not in, and a finished Task never count.
 */
export async function projectOpenTaskCounts(
  db: PrismaClient,
  workspaceId: string,
  reader: { userId: string } | { agentId: string },
): Promise<Map<string, number>> {
  const rows = await db.task.groupBy({
    by: ["projectId"],
    where: {
      workspaceId,
      projectId: { not: null },
      status: { in: UNFINISHED_TASK_STATUSES },
      conversation: {
        OR: [
          visibleChannelWhere(workspaceId, reader),
          "userId" in reader
            ? viewerDirectConversationWhere(reader.userId)
            : {
                directKey: { not: null },
                members: { some: { agentId: reader.agentId, ...ACTIVE_MEMBER_WHERE } },
              },
        ],
      },
    },
    _count: true,
  });
  return new Map(rows.map((row) => [row.projectId!, row._count]));
}
