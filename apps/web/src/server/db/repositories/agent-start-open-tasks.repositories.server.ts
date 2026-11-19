import {
  AGENT_START_OPEN_TASKS_MAX,
  type AgentStartOpenTask,
  type AgentStartOpenTasks,
} from "@lrm/coforge-sdk/internal";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import {
  agentReadableBody,
  MESSAGE_MENTIONS_SELECT,
} from "#src/server/conversations/mentions.server";
import {
  directTargets,
  type DirectTargetOf,
  type TargetConversation,
} from "#src/server/db/repositories/agent-peer-direct.repositories.server";
import { ownTaskScope } from "#src/server/tasks/task-list.server";

const START_OPEN_TASK_STATUSES = ["in_progress", "todo"] as const;
const MAX_WIRE_TITLE_UNITS = 512;

export function boundStartOpenTaskTitle(value: string): string {
  if (value.length <= MAX_WIRE_TITLE_UNITS) return value;
  let cut = MAX_WIRE_TITLE_UNITS - 1;
  const code = value.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${value.slice(0, cut).trimEnd()}…`;
}

export async function readAgentStartOpenTasks(
  db: PrismaClient,
  workspaceId: string,
  agentId: string,
): Promise<AgentStartOpenTasks | undefined> {
  const where = {
    workspaceId,
    deletedAt: null,
    owner: { workspaceId, agentId },
    status: { in: [...START_OPEN_TASK_STATUSES] },
    conversation: ownTaskScope({ agentId }).conversations,
  } satisfies Prisma.TaskWhereInput;

  const rows = await db.task.findMany({
    where,
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }, { id: "desc" }],
    take: AGENT_START_OPEN_TASKS_MAX + 1,
    select: {
      number: true,
      title: true,
      status: true,
      conversation: {
        select: {
          id: true,
          channelName: true,
          directKey: true,
        },
      },
      message: { select: { mentions: MESSAGE_MENTIONS_SELECT } },
    },
  });
  if (rows.length === 0) return undefined;

  const overflow = rows.length > AGENT_START_OPEN_TASKS_MAX;
  const kept = overflow ? rows.slice(0, AGENT_START_OPEN_TASKS_MAX) : rows;
  const dmIds = [
    ...new Set(kept.flatMap((row) => (row.conversation.channelName ? [] : [row.conversation.id]))),
  ];

  const [more, dmResolver] = await Promise.all([
    overflow
      ? db.task.count({ where }).then((total) => Math.max(1, total - AGENT_START_OPEN_TASKS_MAX))
      : Promise.resolve(0),
    dmIds.length > 0
      ? db.conversation
          .findMany({
            where: { workspaceId, id: { in: dmIds } },
            select: {
              id: true,
              channelName: true,
              directKey: true,
              members: {
                where: ACTIVE_MEMBER_WHERE,
                select: {
                  user: { select: { username: true } },
                  agent: { select: { id: true, name: true } },
                },
              },
            },
          })
          .then(async (conversations) => {
            const byId = new Map<string, TargetConversation>(
              conversations.map((conversation) => [conversation.id, conversation]),
            );
            const targetOf: DirectTargetOf = await directTargets(
              db,
              workspaceId,
              agentId,
              conversations,
            );
            return { byId, targetOf };
          })
      : Promise.resolve(undefined),
  ]);

  const tasks: AgentStartOpenTask[] = kept.map((row) => {
    const board = row.conversation.channelName
      ? `#${row.conversation.channelName}`
      : (() => {
          const conversation = dmResolver?.byId.get(row.conversation.id);
          const target = conversation ? dmResolver?.targetOf(conversation) : undefined;
          return `dm:${target ?? "@?"}`;
        })();
    return {
      ref: `${board}:#${row.number}`,
      title: boundStartOpenTaskTitle(agentReadableBody(row.title, row.message?.mentions ?? [])),
      status: row.status === "in_progress" ? "in_progress" : "todo",
    };
  });
  return { tasks, more };
}
