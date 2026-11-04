import { channelLabel, channelVisibilityOf } from "#src/features/conversations/channel-visibility";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { humanLabel } from "#src/lib/human-label";
import { visibleChannelWhere } from "#src/server/conversations/channel-read-access.server";
import { viewerDirectConversationWhere } from "#src/server/conversations/viewer-direct-conversations.server";
import { withProjectIconUrl } from "#src/server/projects/project-images.server";
import { relationsOf, loadTaskRelations } from "./task-relations.server";
import { taskSelection, taskView, type TaskViewExtras } from "./task-view.server";
import type { TaskOverview } from "./task-overview.server";

/** The conversations whose Tasks a Workspace-page read lists: channels the viewer may see. The
 * project page widens it with the viewer's own direct conversations (task #484). */
export function overviewConversationWhere(
  workspaceId: string,
  userId: string,
): Prisma.ConversationWhereInput {
  return visibleChannelWhere(workspaceId, { userId });
}

/** The same, with the viewer's own direct conversations too: a direct message's Task filed under
 * a Project shows on its page only to someone in that DM. */
export function overviewWithDirectsWhere(
  workspaceId: string,
  userId: string,
): Prisma.ConversationWhereInput {
  return {
    OR: [visibleChannelWhere(workspaceId, { userId }), viewerDirectConversationWhere(userId)],
  };
}

export function overviewSelection(userId: string) {
  return {
    ...taskSelection,
    project: { select: { id: true, name: true, slug: true, iconObjectKey: true } },
    conversation: {
      select: {
        channelName: true,
        visibility: true,
        members: {
          where: { OR: [{ userId }, { agentId: { not: null } }] },
          select: {
            id: true,
            userId: true,
            agent: { select: { id: true, name: true, displayName: true } },
            user: { select: { id: true, displayName: true, username: true } },
          },
        },
      },
    },
  } satisfies Prisma.TaskSelect;
}

/** The page's rows: their relations read together, their discussions not counted. */
export async function overviewRows(
  db: PrismaClient,
  userId: string,
  tasks: Array<Prisma.TaskGetPayload<{ select: ReturnType<typeof overviewSelection> }>>,
) {
  const relations = await loadTaskRelations(db, "people", tasks);
  return tasks.map((task) =>
    overviewRow(task, userId, { relations: relationsOf(relations, task.id) }),
  );
}

export function overviewRow(
  task: Prisma.TaskGetPayload<{ select: ReturnType<typeof overviewSelection> }>,
  userId: string,
  extras: TaskViewExtras,
): TaskOverview["tasks"][number] {
  const channelName = task.conversation.channelName;
  const agent = task.conversation.members.find((member) => member.agent !== null)?.agent ?? null;
  const currentMemberId =
    task.conversation.members.find((member) => member.userId === userId)?.id ?? null;
  const peer =
    task.conversation.members.find((member) => member.userId && member.userId !== userId)?.user ??
    null;
  return {
    ...taskView(task, "people", extras),
    currentMemberId,
    source: channelName
      ? {
          channelName,
          agentId: null,
          label: channelLabel({
            name: channelName,
            visibility: channelVisibilityOf(task.conversation),
          }),
        }
      : agent
        ? { channelName: null, agentId: agent.id, label: agent.displayName || agent.name }
        : // A people-to-people DM names the other side (a DM with oneself names oneself).
          {
            channelName: null,
            agentId: null,
            label: peer
              ? humanLabel(peer)
              : humanLabel(
                  task.conversation.members.find((member) => member.userId === userId)!.user!,
                ),
          },
    project: task.project && withProjectIconUrl(task.project),
  };
}
