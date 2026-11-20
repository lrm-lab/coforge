import {
  isTaskCreateStatus,
  type TaskWriteCommand,
  type TaskHistoryChange,
  type TaskPrincipal,
  type TaskPriorityLevel,
  type TaskWriteStatus,
} from "@lrm/coforge-sdk/internal";

import { AppError } from "#src/lib/app-error";
import {
  LABELS_PER_TASK_MAX,
  labelsChange,
  labelView,
  resolveTaskLabels,
  type LabelRow,
} from "./labels.server";
import { TASK_SOURCE_MESSAGE_REQUIRED } from "./task-assign-reason.server";
import { resolveNewTaskProject, type TaskProjectRef } from "./task-projects.server";
import { resolveTaskParent } from "./task-relations-write.server";
import {
  lockConversation,
  lockWorkspaceTaskWrites,
} from "#src/server/conversations/conversation-lock.server";
import { assertCanAssignOther } from "./task-assignment-authority.server";
import { assigneeMember } from "./task-assignees.server";
import type { Member, Transaction, TaskBoardPorts } from "./task-board-ports.server";
import { memberId } from "./task-board-ports.server";
import { ensureTaskExecutionSession } from "./task-change.server";
import { findSourceMessage } from "./task-claims.server";
import { creationChanges, historyRows } from "./task-history.server";
import { postSourceNotice, signalNotices, type PostedNotice } from "./task-notice-posting.server";
import { noticeActor, noticeAssignee } from "./task-notices.server";
import { announceNeighbours, announceTasks } from "./task-publication.server";
import { conversationSignalScopes } from "#src/server/conversations/conversation-signal-scope.server";
import { indexedRequestId } from "./task-request-ids.server";
import { linkCreatedTasks } from "./task-gates.server";
import { assignmentQueueNotes } from "./task-queue.server";
import { ownTaskScope } from "./task-list.server";
import { NEW_TASK_COUNTS, parentTasksOf, taskViewsOf } from "./task-relations.server";
import { postTaskNotice } from "./task-conversations.server";
import { createTaskThread, followTask } from "./task-discussion-store.server";
import { TASK_CREATES_RESOURCE_RETIRED } from "./task-resource-receipt.server";
import {
  taskSelection,
  readTaskText,
  type SelectedTask,
  LIVE_TASK_WHERE,
} from "./task-view.server";

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
  command: TaskWriteCommand,
) {
  const convert = command.operation === "convert";
  if (convert && (!command.messageId || command.messageIds || command.title || command.titles))
    throw new AppError("INVALID_INPUT");
  const titles = convert ? [""] : (command.titles ?? [command.title!]).map((title) => title.trim());
  if (command.description != null && titles.length !== 1) throw new AppError("INVALID_INPUT");
  if (command.attachmentId) throw new AppError("INVALID_INPUT");
  // A resource receipt was anchored to the message a v1 task was; a task with its own
  // conversation has none, so no new task is a resource task. Existing ones still take receipts.
  if (command.createsResource)
    throw new AppError("INVALID_INPUT", {
      errorId: TASK_CREATES_RESOURCE_RETIRED,
      hint: "new tasks no longer track resources: drop --creates-resource. `coforge task receipt` still records the receipt of a task created with it before",
    });
  if (command.alongside && !command.messageId) throw new AppError("INVALID_INPUT");
  if (_principal.agentId && !convert && !command.messageId)
    throw new AppError("INVALID_INPUT", {
      errorId: TASK_SOURCE_MESSAGE_REQUIRED,
      hint: "Creating a task requires --message-id <id> (the channel message that asked for the work; a thread reply resolves to its thread root). For your own idea, first post a message in the channel saying what and why, then create the task from it.",
    });
  const requestIds = await Promise.all(
    titles.map((_, index) => indexedRequestId(command.idempotencyKey, index)),
  );
  const result = await ports.db.$transaction(async (tx) => {
    await lockWorkspaceTaskWrites(tx, scope.workspaceId);
    await lockConversation(tx, scope.conversationId);
    const retried = await tx.task.findMany({
      where: {
        conversationId: scope.conversationId,
        creatorMemberId: memberId(member),
        requestId: { in: requestIds },
        ...LIVE_TASK_WHERE,
      },
      orderBy: { number: "asc" },
      select: taskSelection,
    });
    if (retried.length) {
      if (retried.length !== titles.length) throw new AppError("CONFLICT");
      return { tasks: retried, created: false, notices: [], sourceThreadReplyId: undefined };
    }
    const source = command.messageId
      ? await findSourceMessage(tx, scope.conversationId, command.messageId, {
          allowThreadReply: !convert,
        })
      : null;
    const assignee = command.assignee
      ? await assigneeMember(tx, scope.conversationId, scope.workspaceId, command.assignee)
      : null;
    if (command.assignee && !assignee) throw new AppError("NOT_FOUND");
    if (assignee && assignee.id !== member.id)
      await assertCanAssignOther(tx, scope.workspaceId, member);
    if (command.status !== undefined && !isTaskCreateStatus(command.status))
      throw new AppError("INVALID_INPUT");
    const initial = command.status;
    const labels = await resolveTaskLabels(
      tx,
      scope.workspaceId,
      command.labels ?? [],
      command.labelDescription !== undefined
        ? { description: command.labelDescription }
        : undefined,
    );
    const singleGroup = new Map<string, string>();
    for (const label of labels) {
      if (label.group?.selection !== "single") continue;
      const other = singleGroup.get(label.group.id);
      if (other)
        throw new AppError("INVALID_INPUT", {
          errorId: "task-label-group-single",
          hint: `"${other}" and "${label.name}" are both in the single group "${label.group.name}"; a task carries one of them`,
        });
      singleGroup.set(label.group.id, label.name);
    }
    if (labels.length > LABELS_PER_TASK_MAX)
      throw new AppError("INVALID_INPUT", {
        errorId: "task-label-limit",
        hint: `a task carries at most ${LABELS_PER_TASK_MAX} labels`,
      });
    const parent = await resolveTaskParent(tx, scope, member, command.parent, []);
    const project = await resolveNewTaskProject(tx, scope, member, command, parent);
    const written = convert ? [sourceTitle(source!)] : titles;
    if (written.some((title) => !title || title.length > 8_000))
      throw new AppError("INVALID_INPUT");
    const first = await allocateTaskNumbers(tx, scope.conversationId, written.length);
    const tasks: SelectedTask[] = [];
    const notices: PostedNotice[] = [];
    const priority = command.priority ?? "medium";
    for (const [index, title] of written.entries()) {
      const { task, notice } = await insertConversationTask(tx, scope, member, {
        number: first + index,
        title,
        description: command.description,
        createsResource: command.createsResource ?? false,
        priority,
        dueAt: command.dueAt ? new Date(command.dueAt) : null,
        dueHasTime: command.dueAt ? (command.dueHasTime ?? true) : false,
        status: initial,
        assignee,
        requestId: requestIds[index]!,
        source,
        labels,
        project,
        deferAssignedNotice: true,
      });
      tasks.push(task);
      if (notice) notices.push(notice);
    }
    await linkCreatedTasks(tx, scope, member, tasks, command);
    if (assignee && assignee.id !== member.id) {
      const queueNotes = assignee.agentId
        ? await assignmentQueueNotes(
            tx,
            ports.reader,
            scope,
            member,
            assignee,
            tasks,
            ownTaskScope({ agentId: assignee.agentId }).conversations,
          )
        : undefined;
      for (const [index, task] of tasks.entries()) {
        const queueNote = queueNotes?.get(task.id);
        await postTaskNotice(tx, scope, task.id, {
          body: `${actorHandle(member)} assigned you task #${task.number}: ${task.title}${queueNote ? ` — ${queueNote}` : ""}`,
          system: {
            kind: "task.assigned_you",
            params: {
              actor: noticeActor(member),
              task: { taskId: task.id, number: task.number, title: task.title },
              assignee: noticeAssignee(assignee),
            },
          },
          deliverToAgentId: assignee.agentId,
        });
        tasks[index] = await tx.task.findUniqueOrThrow({
          where: { id: task.id },
          select: taskSelection,
        });
      }
    }
    return {
      tasks,
      created: true,
      notices,
      sourceThreadReplyId: source?.sourceThreadReplyId,
    };
  });
  if (result.created) {
    await signalNotices(ports, result.notices);
    const scopes = await conversationSignalScopes(
      ports.db,
      scope.conversationId,
      scope.workspaceId,
    );
    const parents = command.parent ? await parentTasksOf(ports.db, result.tasks) : [];
    const here = parents.filter((parent) => parent.conversationId === scope.conversationId);
    await announceTasks(ports, scope, async () => scopes.task, {
      tasks: [
        ...(await taskViewsOf(ports.db, "people", result.tasks, NEW_TASK_COUNTS)),
        ...(await taskViewsOf(ports.db, "people", here)),
      ],
      publicationId: `${result.tasks[0]!.id}:task-created`,
    }).catch(() => undefined);
    if (parents.length)
      await announceNeighbours(
        ports,
        scope.conversationId,
        parents,
        `${result.tasks[0]!.id}:task-created`,
      ).catch(() => undefined);
  }
  const views = await taskViewsOf(ports.db, ports.reader, result.tasks, NEW_TASK_COUNTS);
  return {
    tasks: result.sourceThreadReplyId
      ? views.map((view) => ({ ...view, sourceThreadReplyId: result.sourceThreadReplyId }))
      : views,
  };
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

type SourceMessage = Pick<
  Awaited<ReturnType<typeof findSourceMessage>>,
  "id" | "senderMemberId" | "body" | "mentions"
> & { sourceThreadReplyId?: string };

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
    priority?: TaskPriorityLevel;
    /** The due instant the new Task opens with; null or absent for none. */
    dueAt?: Date | null;
    dueHasTime?: boolean;
    /** The status the new Task opens in; absent, the defaults (a self-assign starts in
     * progress, anything else waits in todo). */
    status?: TaskWriteStatus;
    assignee: Awaited<ReturnType<typeof assigneeMember>>;
    requestId: string;
    source: SourceMessage | null;
    /** The Workspace labels the new Task carries; none for a conversion. */
    labels?: readonly LabelRow[];
    /** The Project the new Task is filed under; the conversation's unless it was chosen. */
    project?: TaskProjectRef | null;
    /** Post the assignee's notice later, once the caller has linked the new Tasks' relations
     * (their queue note reads them); the task then comes back unread for its conversation. */
    deferAssignedNotice?: boolean;
  },
) {
  const { assignee, source } = input;
  const started = assignee?.id === member.id;
  // "Claimed" is the create's self-assign start; an explicit initial status defers to itself
  // (task #61) — a self-assign parked elsewhere is held, not started.
  const claimed = started && (input.status === undefined || input.status === "in_progress");
  const task = await tx.task.create({
    data: {
      id: Bun.randomUUIDv7(),
      discussionConversationId: await createTaskThread(tx, scope.workspaceId),
      conversationId: scope.conversationId,
      workspaceId: scope.workspaceId,
      number: input.number,
      title: input.title,
      description: input.description,
      createsResource: input.createsResource ?? false,
      priority: input.priority ?? "medium",
      dueAt: input.dueAt ?? null,
      dueHasTime: input.dueAt ? (input.dueHasTime ?? true) : false,
      ownerMemberId: assignee?.id,
      status: input.status ?? (started ? "in_progress" : "todo"),
      claimedAt: claimed ? new Date() : null,
      creatorMemberId: memberId(member),
      requestId: input.requestId,
      sourceMessageId: source?.id,
      projectId: input.project?.id,
    },
    select: taskSelection,
  });
  const labels = input.labels ?? [];
  if (labels.length)
    await tx.taskLabel.createMany({
      data: labels.map((label) => ({ taskId: task.id, labelId: label.id })),
    });
  const labelsAdded = labelsChange(labels.map(labelView), []);
  const projectAdded: TaskHistoryChange | null = input.project
    ? { eventType: "project_changed", payload: { from: null, to: input.project } }
    : null;
  await tx.taskHistoryEvent.createMany({
    data: historyRows(
      task.id,
      member,
      [
        ...creationChanges(task),
        ...(labelsAdded ? [labelsAdded] : []),
        ...(projectAdded ? [projectAdded] : []),
      ],
      0,
    ),
  });
  await followTask(tx, scope, task.id, memberId(member), "created");
  if (assignee && assignee.id !== member.id)
    await followTask(tx, scope, task.id, assignee.id, "assigned");
  if (assignee?.agentId && claimed) await ensureTaskExecutionSession(tx, task, assignee.agentId);
  // The assignee's notice is in the task's conversation, so the task is read again to carry its unread state.
  const assigned = assignee && assignee.id !== member.id;
  if (assigned && !input.deferAssignedNotice)
    await postTaskNotice(tx, scope, task.id, {
      body: `${actorHandle(member)} assigned you task #${task.number}: ${input.title}`,
      system: {
        kind: "task.assigned_you",
        params: {
          actor: noticeActor(member),
          task: { taskId: task.id, number: task.number, title: input.title },
          assignee: noticeAssignee(assignee),
        },
      },
      deliverToAgentId: assignee.agentId,
    });
  const notice =
    source && source.senderMemberId !== member.id
      ? await postSourceNotice(
          tx,
          scope,
          source.id,
          { id: task.id, number: task.number, title: input.title },
          noticeActor(member),
        )
      : undefined;
  return {
    task:
      assigned && !input.deferAssignedNotice
        ? await tx.task.findUniqueOrThrow({ where: { id: task.id }, select: taskSelection })
        : task,
    notice,
  };
}

const actorHandle = (member: Member) =>
  `@${member.agent?.name ?? member.user?.username ?? "someone"}`;
