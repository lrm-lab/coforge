import { channelLabel, channelVisibilityOf } from "#src/features/conversations/channel-visibility";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { humanLabel } from "#src/lib/human-label";
import { visibleChannelWhere } from "#src/server/conversations/channel-read-access.server";
import { viewerDirectConversationWhere } from "#src/server/conversations/viewer-direct-conversations.server";
import { withProjectIconUrl } from "#src/server/projects/project-images.server";
import { viewsWithCounts } from "./task-discussion-counts.server";
import { taskSelection, taskView, type TaskViewExtras } from "./task-view.server";
import type { TaskOverview } from "./task-overview.server";

/**
 * The conversations whose Tasks a Workspace-page read lists: the channels the viewer may see and
 * their own direct conversations. A DM's Task shows on All tasks and its Project's board only to
 * someone in that DM (task #596); a private channel's only to its members.
 */
export function overviewConversationWhere(
  workspaceId: string,
  userId: string,
): Prisma.ConversationWhereInput {
  return {
    OR: [visibleChannelWhere(workspaceId, { userId }), viewerDirectConversationWhere(userId)],
  };
}

// A card never renders a Task's description, so the board's reads leave it out; the one-Task
// read behind the popup (`overviewDetailSelection`) selects it.
const { description: _description, ...taskCardFields } = taskSelection;

export function overviewSelection(userId: string) {
  return {
    ...taskCardFields,
    project: { select: { id: true, name: true, slug: true, iconObjectKey: true } },
    conversation: {
      select: {
        channelName: true,
        visibility: true,
        members: {
          // The viewer's own membership, the Agents, and both sides of a direct conversation
          // (only ever two): a people-to-people DM is named for the other person.
          where: {
            OR: [{ userId }, { agentId: { not: null } }, { conversation: { channelName: null } }],
          },
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

/** The single-Task read: the card fields plus the description the popup shows. */
export function overviewDetailSelection(userId: string) {
  return { ...overviewSelection(userId), description: true } satisfies Prisma.TaskSelect;
}

/** The page's rows: their relations read together and their discussions counted, once for the page. */
export async function overviewRows(
  db: PrismaClient,
  workspaceId: string,
  userId: string,
  tasks: Array<Prisma.TaskGetPayload<{ select: ReturnType<typeof overviewSelection> }>>,
) {
  if (!tasks.length) return [];
  return viewsWithCounts(db, "people", workspaceId, tasks, (task, extras) =>
    overviewRow(task, userId, extras),
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
