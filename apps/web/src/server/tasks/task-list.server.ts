import { AppError } from "#src/lib/app-error";
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
import { NOT_BLOCKED_WHERE, showRelations } from "./task-relations.server";
import { labelFilterWhere } from "./labels.server";
import { byPriority } from "./task-priority.server";
import {
  CONVERSATION_KIND_WHERE,
  TASK_SCOPE_WHERE,
  UNFINISHED_TASK_STATUSES,
  taskSelection,
  taskView,
} from "./task-view.server";

/** A Task ready to start: Todo, held by nobody, and waiting for no unfinished blocker. */
const READY_TASK_WHERE = {
  status: "todo",
  ownerMemberId: null,
  ...NOT_BLOCKED_WHERE,
} satisfies Prisma.TaskWhereInput;

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
  const labels = await labelFilterWhere(ports.db, principal.workspaceId, command.labels);
  const tasks = await ports.db.task.findMany({
    where: {
      workspaceId: principal.workspaceId,
      owner: actor,
      status:
        command.status === "all" ? undefined : (command.status ?? { in: UNFINISHED_TASK_STATUSES }),
      conversation: scope.conversations,
      ...(labels ?? {}),
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
  // Highest priority first; within a level, oldest first across conversations.
  return {
    tasks: byPriority(
      await viewsWithCounts(
        ports.db,
        ports.reader,
        principal.workspaceId,
        tasks,
        (task, extras) => ({
          ...taskView(task, ports.reader, extras),
          channelRef: task.conversation.channelName
            ? `#${task.conversation.channelName}`
            : `@${task.conversation.members[0]!.user!.username}`,
        }),
      ),
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    ),
    coverage: scope.coverage,
    pagination: { mode: "complete", truncated: false },
  };
}

/** One task's current card, as `task show` reads it. */
export async function showTask(
  ports: TaskBoardPorts,
  workspaceId: string,
  conversationId: string,
  command: TaskCommand,
): Promise<TaskResult> {
  const task = await ports.db.task.findFirst({
    where: { conversationId, number: command.number },
    select: taskSelection,
  });
  if (!task) throw new AppError("NOT_FOUND");
  return {
    tasks: await viewsWithCounts(ports.db, ports.reader, workspaceId, [task], (row, extras) =>
      taskView(row, ports.reader, extras),
    ),
    ...(await showRelations(ports.db, ports.reader, task)),
  };
}

/** One conversation's Tasks, optionally of one status. */
export async function listConversationTasks(
  ports: TaskBoardPorts,
  workspaceId: string,
  conversationId: string,
  command: TaskCommand,
): Promise<TaskResult> {
  const labels = await labelFilterWhere(ports.db, workspaceId, command.labels);
  const tasks = await ports.db.task.findMany({
    where: {
      conversationId: conversationId,
      ...(command.ready
        ? READY_TASK_WHERE
        : {
            status: command.status === "all" ? undefined : command.status,
          }),
      ...(labels ?? {}),
    },
    orderBy: { number: "asc" },
    select: taskSelection,
  });
  // Highest priority first; within a level, by number (oldest first), as read.
  return {
    tasks: byPriority(
      await viewsWithCounts(ports.db, ports.reader, workspaceId, tasks, (task, extras) =>
        taskView(task, ports.reader, extras),
      ),
    ),
  };
}
