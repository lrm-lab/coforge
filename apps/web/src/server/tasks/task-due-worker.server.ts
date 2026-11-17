import type { PrismaClient } from "#src/generated/prisma/client";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import { lockConversation } from "#src/server/conversations/conversation-lock.server";
import { allocateSequence } from "#src/server/db/repositories/sequence-allocation.server";
import type { TaskBoardPorts } from "./task-board-ports.server";
import { discussionOf, joinDiscussion } from "./task-discussion-store.server";
import { publishTaskConversationMessage } from "./task-publication.server";
import { readTaskText, TASK_MEMBER_SELECT } from "./task-view.server";

export const TASK_DUE_SWEEP_INTERVAL_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

type MemberRow = {
  id: string;
  userId: string | null;
  agentId: string | null;
  user: { id: string; username: string; name: string | null } | null;
  agent: { id: string; name: string } | null;
};

function memberHandle(member: MemberRow): string | null {
  if (member.agent) return member.agent.name;
  if (member.user) return member.user.username;
  return null;
}

function formatDueForNotice(dueAt: Date, dueHasTime: boolean): string {
  if (!dueHasTime) {
    return new Date(dueAt.getTime() - 1).toISOString().slice(0, 10);
  }
  return dueAt.toISOString();
}

function buildDueNoticeBody(input: {
  primaryHandle: string;
  ccHandle: string | null;
  occurrence: number;
  title: string;
  status: string;
  dueAt: Date;
  dueHasTime: boolean;
  lastDiscussion: string;
}): string {
  const cc = input.ccHandle ? ` (CC @${input.ccHandle})` : "";
  const heading =
    input.occurrence === 1
      ? `@${input.primaryHandle}${cc} Task due: "${input.title}"`
      : `@${input.primaryHandle}${cc} Overdue reminder #${input.occurrence}: "${input.title}"`;
  return [
    heading,
    `Status: ${input.status} | Due: ${formatDueForNotice(input.dueAt, input.dueHasTime)}`,
    `Last discussion: ${input.lastDiscussion}`,
    `Next step: advance the task, submit for review, reschedule (--due), or close it.`,
  ].join("\n");
}

/**
 * Periodically scans open tasks whose `dueAt <= now` (unlocked, backed by `tasks_dueAt_open_idx`),
 * claims `(taskId, dueAt, targetOccurrence)` via `INSERT ... ON CONFLICT DO NOTHING RETURNING`
 * so multi-instance workers never double-notify, and posts a targeted system notice in the task's
 * discussion thread mentioning and delivering only to the intended recipient(s).
 */
export async function sweepDueTasks(
  db: PrismaClient,
  centrifugo?: Pick<CentrifugoServerApi, "publish" | "publishBatch">,
  now: Date = new Date(),
  workspaceId?: string,
): Promise<number> {
  const candidates = await db.task.findMany({
    where: {
      ...(workspaceId ? { workspaceId } : {}),
      dueAt: { not: null, lte: now },
      deletedAt: null,
      status: { notIn: ["done", "closed"] },
    },
    select: {
      id: true,
      workspaceId: true,
      conversationId: true,
      number: true,
      title: true,
      status: true,
      dueAt: true,
      dueHasTime: true,
      ownerMemberId: true,
      creatorMemberId: true,
      discussionConversationId: true,
      owner: { select: TASK_MEMBER_SELECT },
      creator: { select: TASK_MEMBER_SELECT },
      message: {
        select: {
          mentions: {
            select: {
              handle: true,
              kind: true,
              actorId: true,
              member: {
                select: {
                  user: { select: { displayName: true } },
                  agent: { select: { displayName: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  if (candidates.length === 0) return 0;

  const ports: TaskBoardPorts = {
    db,
    reader: "agent",
    dependencies: centrifugo
      ? {
          realtime: new CentrifugoConversationRealtime(centrifugo as CentrifugoServerApi),
          publisher: centrifugo,
        }
      : {},
  };

  let notified = 0;

  for (const task of candidates) {
    const dueAt = task.dueAt;
    if (!dueAt) continue;

    const targetOccurrence = 1 + Math.floor((now.getTime() - dueAt.getTime()) / DAY_MS);
    if (targetOccurrence < 1) continue;

    const primary = (task.owner ?? task.creator) as MemberRow | null;
    if (!primary) continue;
    const primaryHandle = memberHandle(primary);
    if (!primaryHandle) continue;

    const cc =
      targetOccurrence >= 2 && task.creator && task.creator.id !== primary.id
        ? (task.creator as MemberRow)
        : null;
    const ccHandle = cc ? memberHandle(cc) : null;

    const recipients = cc && ccHandle ? [primary, cc] : [primary];

    const lastMessage = task.discussionConversationId
      ? await db.message.findFirst({
          where: { conversationId: task.discussionConversationId },
          orderBy: { sequence: "desc" },
          select: {
            createdAt: true,
            sender: {
              select: {
                user: { select: { username: true } },
                agent: { select: { name: true } },
              },
            },
          },
        })
      : null;

    const lastSender = lastMessage?.sender?.agent?.name
      ? `@${lastMessage.sender.agent.name}`
      : lastMessage?.sender?.user?.username
        ? `@${lastMessage.sender.user.username}`
        : "system";
    const lastDiscussion = lastMessage
      ? `${lastSender} (${lastMessage.createdAt.toISOString()})`
      : "none yet";

    const readableTitle = readTaskText(task.title, "agent", task.message?.mentions ?? []);
    const body = buildDueNoticeBody({
      primaryHandle,
      ccHandle,
      occurrence: targetOccurrence,
      title: readableTitle,
      status: task.status,
      dueAt,
      dueHasTime: task.dueHasTime,
      lastDiscussion,
    });

    const postedMessageId = await db.$transaction(async (tx) => {
      const claimed = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "task_due_reminders" ("id", "taskId", "dueAt", "occurrence")
        VALUES (${Bun.randomUUIDv7()}::uuid, ${task.id}::uuid, ${dueAt}, ${targetOccurrence})
        ON CONFLICT ("taskId", "dueAt", "occurrence") DO NOTHING
        RETURNING "id"
      `;
      if (claimed.length === 0) return null;

      const discussionConversationId = await discussionOf(
        tx,
        { id: task.id, discussionConversationId: task.discussionConversationId },
        task.workspaceId,
      );
      await lockConversation(tx, discussionConversationId);
      const sequence = await allocateSequence(tx, discussionConversationId);

      const discussionMembers = await Promise.all(
        recipients.map(async (member) => ({
          member,
          seat: await joinDiscussion(tx, task.workspaceId, discussionConversationId, member),
        })),
      );

      const mentionCreates = discussionMembers.flatMap(({ member, seat }) => {
        const handle = memberHandle(member);
        if (!handle) return [];
        const actorId = member.agentId ?? member.userId;
        if (!actorId) return [];
        return [
          {
            memberId: seat.id,
            workspaceId: task.workspaceId,
            kind: member.agentId ? ("agent" as const) : ("user" as const),
            actorId,
            handle,
          },
        ];
      });

      const deliveryCreates = recipients.flatMap((member) =>
        member.agentId
          ? [
              {
                workspaceId: task.workspaceId,
                conversationId: discussionConversationId,
                agentId: member.agentId,
                sequence,
              },
            ]
          : [],
      );

      const message = await tx.message.create({
        data: {
          workspaceId: task.workspaceId,
          conversationId: discussionConversationId,
          body,
          sequence,
          mentions: mentionCreates.length ? { create: mentionCreates } : undefined,
          deliveries: deliveryCreates.length ? { create: deliveryCreates } : undefined,
        },
        select: { id: true },
      });

      return message.id;
    });

    if (!postedMessageId) continue;
    notified += 1;
    await publishTaskConversationMessage(ports, postedMessageId, postedMessageId).catch(
      () => undefined,
    );
  }

  return notified;
}
