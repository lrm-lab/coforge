import type { Prisma } from "#src/generated/prisma/client";
import { viewsWithCounts } from "./task-discussion-counts.server";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import { viewerDirectConversationWhere } from "#src/server/conversations/viewer-direct-conversations.server";
import { requireWorkspaceMember } from "#src/server/workspaces/workspace-membership.server";
import type {
  TaskCommand,
  TaskConversationKind,
  TaskListCoverage,
  TaskPrincipal,
  TaskResult,
} from "@lrm/coforge-sdk/internal";
import type { TaskBoardPorts } from "./task-board-ports.server";
import {
  CONVERSATION_KIND_WHERE,
  TASK_SCOPE_WHERE,
  UNFINISHED_TASK_STATUSES,
  taskSelection,
  taskView,
} from "./task-view.server";

/** What an Agent's own Task list reads: every kind, archived channels included. */
const AGENT_OWN_TASK_READ = {
  kinds: ["channel", "dm"] as TaskConversationKind[],
  includesArchived: true,
};

/**
 * AGENT_OWN_TASK_READ supplies both query scope and reported coverage; read every match
 * without pagination so the two cannot drift.
 */
function ownTaskScope(actor: { agentId: string } | { userId: string }): {
  conversations: Prisma.ConversationWhereInput;
  coverage: TaskListCoverage;
} {
  const { kinds, includesArchived } = AGENT_OWN_TASK_READ;
  return {
    conversations: {
      ...TASK_SCOPE_WHERE,
      ...(includesArchived ? {} : { archivedAt: null }),
      OR:
        "agentId" in actor
          ? kinds.map((kind) => CONVERSATION_KIND_WHERE[kind])
          : [{ channelName: { not: null } }, viewerDirectConversationWhere(actor.userId)],
      members: { some: { ...actor, ...ACTIVE_MEMBER_WHERE } },
    },
    coverage: {
      status: "incomplete",
      visibleConversationKinds: [...kinds],
      includesArchived,
      inaccessibleScope: "not_asserted",
      reason:
        "Reads the channels and DMs this Agent is a member of now. A conversation it has left, and a channel hidden from the Workspace, are not read, so Tasks there are not listed.",
    },
  };
}

/** An Agent's (or person's) own list: every Task they hold in the conversations they may read. */
export async function listOwnTasks(
  ports: TaskBoardPorts,
  principal: TaskPrincipal,
  command: TaskCommand,
): Promise<TaskResult> {
  if (principal.userId)
    await requireWorkspaceMember(ports.db, principal.workspaceId, principal.userId);
  const actor = principal.agentId ? { agentId: principal.agentId } : { userId: principal.userId! };
  const scope = ownTaskScope(actor);
  const tasks = await ports.db.task.findMany({
    where: {
      workspaceId: principal.workspaceId,
      owner: actor,
      status:
        command.status === "all" ? undefined : (command.status ?? { in: UNFINISHED_TASK_STATUSES }),
      conversation: scope.conversations,
    },
    orderBy: [{ conversationId: "asc" }, { number: "asc" }],
    select: {
      ...taskSelection,
      conversation: {
        select: {
          channelName: true,
          members: {
            where: { userId: { not: null } },
            select: { user: { select: { username: true } } },
          },
        },
      },
    },
  });
  return {
    tasks: await viewsWithCounts(ports.db, principal.workspaceId, tasks, (task, counts) => ({
      ...taskView(task, ports.reader, counts),
      channelRef: task.conversation.channelName
        ? `#${task.conversation.channelName}`
        : `@${task.conversation.members[0]!.user!.username}`,
    })),
    coverage: scope.coverage,
    pagination: { mode: "complete", truncated: false },
  };
}

/** One conversation's Tasks, optionally of one status. */
export async function listConversationTasks(
  ports: TaskBoardPorts,
  workspaceId: string,
  conversationId: string,
  command: TaskCommand,
): Promise<TaskResult> {
  const tasks = await ports.db.task.findMany({
    where: {
      conversationId: conversationId,
      status: command.status === "all" ? undefined : command.status,
    },
    orderBy: { number: "asc" },
    select: taskSelection,
  });
  return {
    tasks: await viewsWithCounts(ports.db, workspaceId, tasks, (task, counts) =>
      taskView(task, ports.reader, counts),
    ),
  };
}
