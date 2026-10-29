import { taskSelection } from "./task-view.server";
import type { TaskCommand, TaskResult } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import { conversationSignalScopes } from "#src/server/conversations/conversation-realtime.server";
import { noticeActor, noticeText } from "./task-notices.server";
import { historyEventView } from "./task-history.server";
import { storedTaskStatus, readTaskText, taskView } from "./task-view.server";
import type { TaskBoardPorts, Member, ConversationRef } from "./task-board-ports.server";
import { findTaskByNumber, assertExpectedRevision, commitTaskChange } from "./task-change.server";
import { withNotices } from "./task-notice-posting.server";
import { signalTaskChange, announceTasks } from "./task-publication.server";
import { requireManager, isTaskManager } from "./task-assignees.server";
import { ordinaryTaskStatusMove } from "./task-status-transitions.server";

export async function updateTaskStatus(
  ports: TaskBoardPorts,
  conversation: ConversationRef,
  member: Member,
  command: TaskCommand,
) {
  const { conversationId } = conversation;
  const status = command.status;
  if (status === undefined || status === "all") throw new AppError("INVALID_INPUT");
  const task = await findTaskByNumber(ports.db, conversationId, command.number!);
  if (!task) throw new AppError("NOT_FOUND");
  assertExpectedRevision(task, command.expectedRevision);
  // Anyone who may speak in this conversation moves a Task, an Agent included; a Workspace owner
  // or admin may set any status, everyone else only along the board's own transitions.
  if (!(await isTaskManager(ports.db, conversation.workspaceId, member)))
    if (!ordinaryTaskStatusMove(storedTaskStatus(task.status), status))
      throw new AppError("ACCESS_DENIED");
  if (status !== "todo" && status !== "closed" && !task.ownerMemberId)
    throw new AppError("CONFLICT");
  if (status === "done" && task.createsResource && !task.resourceReceipt)
    throw new AppError("CONFLICT");
  const updated = await withNotices(ports, conversation, async (tx, notices) => {
    const { task: updated } = await commitTaskChange(
      tx,
      member,
      task,
      { ownerMemberId: task.ownerMemberId },
      { status },
    );
    if (updated.status !== task.status)
      await notices.inThread(updated, (quoted) =>
        noticeText.moved(noticeActor(member).displayName, quoted, storedTaskStatus(updated.status)),
      );
    return updated;
  });
  await signalTaskChange(ports, updated);
  return { tasks: [taskView(updated, ports.reader)] };
}

export async function amendTask(
  ports: TaskBoardPorts,
  conversationId: string,
  member: Member,
  command: TaskCommand,
): Promise<TaskResult> {
  if (command.title === undefined && command.description === undefined)
    throw new AppError("INVALID_INPUT");
  const result = await ports.db.$transaction(async (tx) => {
    const task = await findTaskByNumber(tx, conversationId, command.number!);
    if (!task) throw new AppError("NOT_FOUND");
    assertExpectedRevision(task, command.expectedRevision);
    // An amended title is typed text. One that reads the same as the current title does for this
    // reader (its stored tokens read back as names or `@handle`, `task #N`, `#name`) is left as
    // stored, tokens included.
    const title = command.title?.trim();
    const retitled =
      title !== undefined &&
      title !== readTaskText(task.title, ports.reader, task.message.mentions);
    return commitTaskChange(
      tx,
      member,
      task,
      {},
      {
        ...(retitled && { title }),
        ...(command.description !== undefined && { description: command.description }),
      },
    );
  });
  await signalTaskChange(ports, result.task);
  return {
    tasks: [taskView(result.task, ports.reader)],
    history: result.events.map((event) =>
      historyEventView(event, ports.reader, result.task.message.mentions),
    ),
  };
}

export async function taskHistory(
  ports: TaskBoardPorts,
  conversationId: string,
  command: TaskCommand,
): Promise<TaskResult> {
  const task = await ports.db.task.findUnique({
    where: {
      conversationId_number: { conversationId, number: command.number! },
    },
    select: {
      ...taskSelection,
      history: { orderBy: { seq: "asc" } },
    },
  });
  if (!task) throw new AppError("NOT_FOUND");
  return {
    tasks: [taskView(task, ports.reader)],
    history: task.history.map((event) =>
      historyEventView(event, ports.reader, task.message.mentions),
    ),
  };
}

export async function deleteTask(
  ports: TaskBoardPorts,
  conversationId: string,
  workspaceId: string,
  member: Member,
  command: TaskCommand,
): Promise<TaskResult> {
  const task = await ports.db.task.findUnique({
    where: {
      conversationId_number: { conversationId, number: command.number! },
    },
    select: { messageId: true, creatorMemberId: true },
  });
  if (!task) throw new AppError("NOT_FOUND");
  if (task.creatorMemberId !== member.id) await requireManager(ports.db, workspaceId, member);
  await ports.db.task.delete({ where: { messageId: task.messageId } });
  await announceTasks(
    ports,
    { conversationId, workspaceId },
    async () => (await conversationSignalScopes(ports.db, conversationId, workspaceId)).task,
    { deleted: [task.messageId], publicationId: `${task.messageId}:task-deleted` },
  );
  return { tasks: [] };
}
