import type { TaskCommand, TaskPrincipal } from "@lrm/coforge-sdk/internal";

import { AppError } from "#src/lib/app-error";
import { lockConversation } from "#src/server/conversations/conversation-lock.server";
import { assertCanAssignOther } from "./task-assignment-authority.server";
import { assigneeMember } from "./task-assignees.server";
import type { Member, Transaction, TaskBoardPorts } from "./task-board-ports.server";
import { ensureTaskExecutionSession } from "./task-change.server";
import { findSourceMessage } from "./task-claims.server";
import { creationChanges, historyRows } from "./task-history.server";
import { postSourceNotice, signalNotices, type PostedNotice } from "./task-notice-posting.server";
import { noticeActor } from "./task-notices.server";
import { announceTasks } from "./task-publication.server";
import { conversationSignalScopes } from "#src/server/conversations/conversation-signal-scope.server";
import { indexedRequestId } from "./task-request-ids.server";
import { postTaskNotice } from "./task-conversations.server";
import {
  taskSelection,
  taskView,
  UNFINISHED_TASK_STATUSES,
  readTaskText,
  type SelectedTask,
} from "./task-view.server";

/** The message already has someone else's live task: who holds it, so the creator can add to that
 * task or say `alongside`. */
export const SOURCE_MESSAGE_TAKEN = "source_message_taken";
export class SourceMessageTaken extends AppError {
  constructor(
    readonly taskNumber: number,
    readonly holder: string,
  ) {
    super("CONFLICT", { errorId: SOURCE_MESSAGE_TAKEN });
  }
}

/**
 * Creates tasks under task conversations: no message is posted in the channel. Each task gets its
 * own id, may name the channel message it was made from, and is followed by its creator (and, for
 * an assignee, by them). The assignee is told in the task's own conversation, which this makes.
 * `convert` is the person's "make this message a task": the same, with the message's text as the
 * title and the message as its source.
 */
export async function createConversationTasks(
  ports: TaskBoardPorts,
  scope: { conversationId: string; workspaceId: string; channel: boolean },
  member: Member,
  _principal: TaskPrincipal,
  command: TaskCommand,
) {
  const convert = command.operation === "convert";
  if (convert && (!command.messageId || command.messageIds || command.title || command.titles))
    throw new AppError("INVALID_INPUT");
  const titles = convert ? [""] : (command.titles ?? [command.title!]).map((title) => title.trim());
  if (command.description != null && titles.length !== 1) throw new AppError("INVALID_INPUT");
  // A resource task records its receipt against a message, which this task does not have yet.
  if (command.attachmentId || command.createsResource) throw new AppError("INVALID_INPUT");
  if (command.alongside && !command.messageId) throw new AppError("INVALID_INPUT");
  const requestIds = await Promise.all(
    titles.map((_, index) => indexedRequestId(command.idempotencyKey, index)),
  );
  const result = await ports.db.$transaction(async (tx) => {
    await lockConversation(tx, scope.conversationId);
    const retried = await tx.task.findMany({
      where: {
        conversationId: scope.conversationId,
        creatorMemberId: member.id,
        requestId: { in: requestIds },
      },
      orderBy: { number: "asc" },
      select: taskSelection,
    });
    if (retried.length) {
      if (retried.length !== titles.length) throw new AppError("CONFLICT");
      return { tasks: retried, created: false, notices: [] };
    }
    const source = command.messageId
      ? await findSourceMessage(tx, scope.conversationId, command.messageId)
      : null;
    if (source && !command.alongside) await assertSourceFree(tx, source.id, member.id);
    const assignee = command.assignee
      ? await assigneeMember(tx, scope.conversationId, scope.workspaceId, command.assignee)
      : null;
    if (command.assignee && !assignee) throw new AppError("NOT_FOUND");
    if (assignee && assignee.id !== member.id)
      await assertCanAssignOther(tx, scope.workspaceId, member);
    const written = convert ? [sourceTitle(source!)] : titles;
    if (written.some((title) => !title || title.length > 8_000))
      throw new AppError("INVALID_INPUT");
    const first = await allocateTaskNumbers(tx, scope.conversationId, written.length);
    const tasks: SelectedTask[] = [];
    const notices: PostedNotice[] = [];
    for (const [index, title] of written.entries()) {
      const { task, notice } = await insertConversationTask(tx, scope, member, {
        number: first + index,
        title,
        description: command.description,
        createsResource: command.createsResource ?? false,
        assignee,
        requestId: requestIds[index]!,
        source,
      });
      tasks.push(task);
      if (notice) notices.push(notice);
    }
    return { tasks, created: true, notices };
  });
  if (result.created) {
    await signalNotices(ports, result.notices);
    const scopes = await conversationSignalScopes(
      ports.db,
      scope.conversationId,
      scope.workspaceId,
    );
    await announceTasks(ports, scope, async () => scopes.task, {
      tasks: result.tasks.map((task) => taskView(task, "people")),
      publicationId: `${result.tasks[0]!.id}:task-created`,
    }).catch(() => undefined);
  }
  return { tasks: result.tasks.map((task) => taskView(task, ports.reader)) };
}

/** The numbers a conversation's next `count` tasks take; the caller holds its lock. */
export async function allocateTaskNumbers(tx: Transaction, conversationId: string, count: number) {
  const [allocated] = await tx.$queryRaw<Array<{ first: number }>>`
    UPDATE "conversations"
    SET "nextTaskNumber" = "nextTaskNumber" + ${count}
    WHERE "id" = ${conversationId}::uuid
    RETURNING "nextTaskNumber" - ${count} AS "first"`;
  if (!allocated) throw new AppError("NOT_FOUND");
  return allocated.first;
}

type SourceMessage = Awaited<ReturnType<typeof findSourceMessage>>;

/** A task's title made from a message: its text as people read it (mentions as names). */
export function sourceTitle(source: Pick<SourceMessage, "body" | "mentions">) {
  return readTaskText(source.body, "people", source.mentions).trim().slice(0, 8_000);
}

/**
 * Writes one task under task conversations with its history and follows, in the caller's
 * transaction (which holds the conversation's lock). A source message someone else wrote gets a
 * line in its thread, so its author learns it became a task: that notice is returned to signal
 * once the transaction commits.
 */
export async function insertConversationTask(
  tx: Transaction,
  scope: { conversationId: string; workspaceId: string },
  member: Member,
  input: {
    number: number;
    title: string;
    description?: string | null;
    createsResource?: boolean;
    assignee: Awaited<ReturnType<typeof assigneeMember>>;
    requestId: string;
    source: SourceMessage | null;
  },
) {
  const { assignee, source } = input;
  const started = assignee?.id === member.id;
  const task = await tx.task.create({
    data: {
      id: Bun.randomUUIDv7(),
      conversationId: scope.conversationId,
      workspaceId: scope.workspaceId,
      number: input.number,
      title: input.title,
      description: input.description,
      createsResource: input.createsResource ?? false,
      ownerMemberId: assignee?.id,
      status: started ? "in_progress" : "todo",
      claimedAt: started ? new Date() : null,
      creatorMemberId: member.id,
      requestId: input.requestId,
      sourceMessageId: source?.id,
    },
    select: taskSelection,
  });
  await tx.taskHistoryEvent.createMany({
    data: historyRows(task.id, member, creationChanges(task), 0),
  });
  await tx.taskFollow.createMany({
    data: [
      follow(task.id, member.id, scope, "created"),
      ...(assignee && assignee.id !== member.id
        ? [follow(task.id, assignee.id, scope, "assigned")]
        : []),
    ],
    skipDuplicates: true,
  });
  if (assignee?.agentId) await ensureTaskExecutionSession(tx, task, assignee.agentId);
  // The assignee's notice makes the task's conversation, so the task is read again to carry it.
  const assigned = assignee && assignee.id !== member.id;
  if (assigned)
    await postTaskNotice(tx, scope, task.id, {
      body: `${actorHandle(member)} assigned you task #${task.number}: ${input.title}`,
      deliverToAgentId: assignee.agentId,
    });
  const notice =
    source && source.senderMemberId !== member.id
      ? await postSourceNotice(
          tx,
          scope,
          source.id,
          { number: task.number, title: input.title },
          noticeActor(member),
        )
      : undefined;
  return {
    task: assigned
      ? await tx.task.findUniqueOrThrow({ where: { id: task.id }, select: taskSelection })
      : task,
    notice,
  };
}

const follow = (
  taskId: string,
  memberId: string,
  scope: { conversationId: string; workspaceId: string },
  reason: "created" | "assigned",
) => ({
  taskId,
  memberId,
  conversationId: scope.conversationId,
  workspaceId: scope.workspaceId,
  reason,
});

const actorHandle = (member: Member) =>
  `@${member.agent?.name ?? member.user?.username ?? "someone"}`;

/**
 * A message may carry several tasks, but not someone else's live one unless the creator says they
 * mean to work beside it (`alongside`): the holder is named so the creator can add to that task.
 */
async function assertSourceFree(tx: Transaction, sourceMessageId: string, creatorMemberId: string) {
  const live = await tx.task.findFirst({
    where: {
      sourceMessageId,
      status: { in: UNFINISHED_TASK_STATUSES },
      ownerMemberId: { not: null, notIn: [creatorMemberId] },
    },
    select: {
      number: true,
      owner: {
        select: { user: { select: { username: true } }, agent: { select: { name: true } } },
      },
    },
  });
  if (!live) return;
  throw new SourceMessageTaken(
    live.number,
    live.owner?.agent?.name ?? live.owner?.user?.username ?? "someone",
  );
}
