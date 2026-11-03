import { taskSelection } from "./task-view.server";
import {
  taskStatusAwaitsReceipt,
  taskStatusMoveAllowed,
  taskStatusNeedsOwner,
  type TaskCommand,
  type TaskHistoryChange,
  type TaskResult,
} from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import { conversationSignalScopes } from "#src/server/conversations/conversation-signal-scope.server";
import { noticeActor, noticeText } from "./task-notices.server";
import { historyEventView } from "./task-history.server";
import { storedTaskStatus, readTaskText, taskMentions } from "./task-view.server";
import { relatedTasks, taskViewOf, taskViewsOf } from "./task-relations.server";
import {
  applyRelationPlan,
  planRelationAmend,
  TASK_RELATION_DENIED,
} from "./task-relations-write.server";
import {
  noticeNowBlocked,
  noticeReleased,
  noticeStatusFollowUps,
  noticeSubtaskDeleted,
  onlyWaitingFor,
  openBlockers,
} from "./task-gates.server";
import type {
  TaskBoardPorts,
  Member,
  ConversationRef,
  Transaction,
} from "./task-board-ports.server";
import { findTaskByNumber, assertExpectedRevision, commitTaskChange } from "./task-change.server";
import { withNotices, type NoticeWriter } from "./task-notice-posting.server";
import { signalTaskChange, announceTasks, announceNeighbours } from "./task-publication.server";
import { requireManager, isTaskManager } from "./task-assignees.server";
import { TASK_PROJECT_SELECT, resolveTaskProject } from "./task-projects.server";
import { assertCanSetPriority } from "./task-priority.server";
import { LABELS_PER_TASK_MAX, labelsChange, labelView, resolveTaskLabels } from "./labels.server";

export async function updateTaskStatus(
  ports: TaskBoardPorts,
  conversation: ConversationRef,
  member: Member,
  command: TaskCommand,
) {
  const { conversationId } = conversation;
  // A status, a priority, or both.
  const { status } = command;
  if ((status === undefined && command.priority === undefined) || status === "all")
    throw new AppError("INVALID_INPUT");
  const task = await findTaskByNumber(ports.db, conversationId, command.number!);
  if (!task) throw new AppError("NOT_FOUND");
  assertExpectedRevision(task, command.expectedRevision);
  const priority = command.priority !== task.priority ? command.priority : undefined;
  if (priority !== undefined) await assertCanSetPriority(ports.db, conversation, member, task);
  // The priority it already has, alone, writes nothing.
  if (status === undefined && priority === undefined)
    return { tasks: [await taskViewOf(ports.db, ports.reader, task)] };
  // Anyone who may speak in this conversation moves a Task, an Agent included; a Workspace owner
  // or admin may set any status, everyone else only along the board's own transitions.
  const manager = await isTaskManager(ports.db, conversation.workspaceId, member);
  if (status !== undefined) {
    if (!taskStatusMoveAllowed(storedTaskStatus(task.status), status, { manager }))
      throw new AppError("ACCESS_DENIED");
    if (taskStatusNeedsOwner(status) && !task.ownerMemberId) throw new AppError("CONFLICT");
    if (
      taskStatusAwaitsReceipt(status, {
        requiresReceipt: task.createsResource,
        hasReceipt: Boolean(task.resourceReceipt),
      })
    )
      throw new AppError("CONFLICT");
  }
  const updated = await withNotices(ports, conversation, async (tx, notices) => {
    // Under the conversation lock, so a blocker finishing at the same time is seen either way.
    const { task: updated } = await commitTaskChange(
      tx,
      member,
      task,
      { ownerMemberId: task.ownerMemberId },
      { ...(status !== undefined && { status }), ...(priority !== undefined && { priority }) },
      { manager },
    );
    if (updated.status !== task.status)
      await notices.inThread(updated, (quoted) => ({
        body: noticeText.moved(
          noticeActor(member).displayName,
          quoted,
          storedTaskStatus(updated.status),
        ),
        system: {
          kind: "task.moved",
          params: {
            actor: noticeActor(member),
            task: quoted,
            status: storedTaskStatus(updated.status),
          },
        },
      }));
    await noticeStatusFollowUps(tx, notices, member, task, updated);
    return updated;
  });
  const view = await taskViewOf(ports.db, ports.reader, updated);
  await signalTaskChange(ports, updated, {
    view,
    // What waits for it and what it belongs to read its status.
    neighbours: updated.status === task.status ? [] : await relatedTasks(ports.db, updated),
  });
  return { tasks: [view] };
}

export async function amendTask(
  ports: TaskBoardPorts,
  conversation: ConversationRef,
  member: Member,
  command: TaskCommand,
): Promise<TaskResult> {
  const { conversationId, workspaceId } = conversation;
  const relational = command.blockedBy !== undefined || command.parent !== undefined;
  const labelEdit = command.labels !== undefined || command.removeLabels !== undefined;
  const projectEdit = command.project !== undefined;
  if (
    command.title === undefined &&
    command.description === undefined &&
    !relational &&
    !labelEdit &&
    !projectEdit
  )
    throw new AppError("INVALID_INPUT");
  const authorityEdit = relational || projectEdit;
  const manager = authorityEdit && (await isTaskManager(ports.db, workspaceId, member));
  const amend = async (tx: Transaction, notices?: NoticeWriter) => {
    const task = await findTaskByNumber(tx, conversationId, command.number!);
    if (!task) throw new AppError("NOT_FOUND");
    assertExpectedRevision(task, command.expectedRevision);
    if (
      authorityEdit &&
      !manager &&
      task.ownerMemberId !== member.id &&
      task.creator.id !== member.id
    )
      throw new AppError("ACCESS_DENIED", {
        errorId: TASK_RELATION_DENIED,
        hint: `only the owner or creator of task #${task.number}, or a Workspace owner or admin, may change what it waits for, its parent or its project`,
      });
    const plan = relational
      ? await planRelationAmend(tx, conversation, member, manager, task, command)
      : undefined;
    // Labels are their own rows: the labels the command adds that the Task lacks and those it
    // takes off that it carries. A name no label has is refused, never created here.
    const [askedLabels, askedRemoved] = labelEdit
      ? await Promise.all([
          resolveTaskLabels(
            tx,
            workspaceId,
            command.labels ?? [],
            command.labelDescription !== undefined
              ? { description: command.labelDescription }
              : undefined,
          ),
          resolveTaskLabels(tx, workspaceId, command.removeLabels ?? []),
        ])
      : [[], []];
    const currentLabelRows = task.labels.map(({ label }) => label);
    const currentLabels = currentLabelRows.map(labelView);
    const currentIds = new Set(currentLabels.map((label) => label.id));
    const addedLabels = askedLabels.filter((label) => !currentIds.has(label.id));
    const askedRemovedLabels = askedRemoved.filter((label) => currentIds.has(label.id));
    // A single group allows one label: adding one takes the group's other label off this Task.
    const replacedLabels = addedLabels.flatMap((label) =>
      label.group?.selection === "single"
        ? currentLabelRows.filter(
            (current) => current.id !== label.id && current.groupId === label.groupId,
          )
        : [],
    );
    const removedLabels = [
      ...askedRemovedLabels,
      ...replacedLabels.filter(
        (label) => !askedRemovedLabels.some((removed) => removed.id === label.id),
      ),
    ];
    const nextLabels = new Set(currentIds);
    for (const label of addedLabels) nextLabels.add(label.id);
    for (const label of removedLabels) nextLabels.delete(label.id);
    if (nextLabels.size > LABELS_PER_TASK_MAX)
      throw new AppError("INVALID_INPUT", {
        errorId: "task-label-limit",
        hint: `a task carries at most ${LABELS_PER_TASK_MAX} labels`,
      });
    const labelChange = labelsChange(addedLabels.map(labelView), removedLabels.map(labelView));
    // The Project: one named (and pinned), or the conversation's again when cleared.
    let nextProject = task.project ?? null;
    let nextPinned = task.projectPinned;
    if (projectEdit) {
      const current = await tx.conversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: { directKey: true, project: { select: TASK_PROJECT_SELECT } },
      });
      if (command.project === null) {
        nextProject = current.project;
        nextPinned = false;
      } else {
        // As at creation: a direct message's Tasks are filed under no Project.
        if (current.directKey)
          throw new AppError("INVALID_INPUT", {
            errorId: "task-project",
            hint: "a direct message's Tasks are not filed under a Project",
          });
        nextProject = await resolveTaskProject(tx, workspaceId, command.project!);
        nextPinned = true;
      }
    }
    const projectChange: TaskHistoryChange | null =
      projectEdit && (nextProject?.id ?? null) !== (task.project?.id ?? null)
        ? { eventType: "project_changed", payload: { from: task.project ?? null, to: nextProject } }
        : null;
    // An amended title is typed text. One that reads the same as the current title does for this
    // reader (its stored tokens read back as names or `@handle`, `task #N`, `#name`) is left as
    // stored, tokens included.
    const title = command.title?.trim();
    const retitled =
      title !== undefined && title !== readTaskText(task.title, ports.reader, taskMentions(task));
    const committed = await commitTaskChange(
      tx,
      member,
      task,
      {},
      {
        ...(retitled && { title }),
        ...(command.description !== undefined && { description: command.description }),
        ...(projectEdit && { projectId: nextProject?.id ?? null, projectPinned: nextPinned }),
      },
      {
        relationChanges: [
          ...(plan?.changes ?? []),
          ...(labelChange ? [labelChange] : []),
          ...(projectChange ? [projectChange] : []),
        ],
      },
    );
    if (removedLabels.length)
      await tx.taskLabel.deleteMany({
        where: { taskId: task.id, labelId: { in: removedLabels.map((label) => label.id) } },
      });
    if (addedLabels.length)
      await tx.taskLabel.createMany({
        data: addedLabels.map((label) => ({ taskId: task.id, labelId: label.id })),
      });
    if (plan && notices) {
      await applyRelationPlan(tx, conversation, member, task, plan);
      await noticeNowBlocked(tx, notices, member, committed.task, plan);
      // Taking away the last open blocker frees the Task for its owner, who did not do it.
      if (plan.removedOpenBlocker && !(await openBlockers(tx, task)).length)
        await noticeReleased(notices, member, [committed.task], String(committed.task.revision));
    }
    return { ...committed, parents: plan?.parents ?? [], retitled };
  };
  // Blockers and parent are checked against the whole graph, so that edit holds the conversation
  // lock; a title or description edit does not need it.
  const result = relational
    ? await withNotices(ports, conversation, (tx, notices) => amend(tx, notices))
    : await ports.db.$transaction((tx) => amend(tx));
  const [related, parents] = await Promise.all([
    // Titles read in the cards of what waits for this Task and of its subtasks.
    result.retitled ? relatedTasks(ports.db, result.task) : [],
    result.parents.length
      ? ports.db.task.findMany({ where: { id: { in: result.parents } }, select: taskSelection })
      : [],
  ]);
  const view = await taskViewOf(ports.db, ports.reader, result.task);
  await signalTaskChange(ports, result.task, {
    view,
    neighbours: [...new Map([...related, ...parents].map((task) => [task.id, task])).values()],
  });
  return {
    tasks: [view],
    history: result.events.map((event) =>
      historyEventView(event, ports.reader, taskMentions(result.task)),
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
    tasks: [await taskViewOf(ports.db, ports.reader, task)],
    history: task.history.map((event) => historyEventView(event, ports.reader, taskMentions(task))),
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
    select: { id: true, status: true, creatorMemberId: true, workspaceId: true },
  });
  if (!task) throw new AppError("NOT_FOUND");
  if (task.creatorMemberId !== member.id) await requireManager(ports.db, workspaceId, member);
  // Under the conversation lock: read what depended on the Task and tell the owners the delete
  // frees (it ends their wait, or finishes their subtasks), then delete.
  const neighbours = await withNotices(
    ports,
    { conversationId, workspaceId },
    async (tx, notices) => {
      // The links go with the Task; what waited for it or belonged to it reads differently now.
      const related = await relatedTasks(tx, task);
      await noticeReleased(notices, member, await onlyWaitingFor(tx, task), task.id);
      await noticeSubtaskDeleted(tx, notices, member, task);
      await tx.task.delete({ where: { id: task.id } });
      return related;
    },
  );
  await Promise.all([
    announceTasks(
      ports,
      { conversationId, workspaceId },
      async () => (await conversationSignalScopes(ports.db, conversationId, workspaceId)).task,
      {
        deleted: [task.id],
        tasks: await taskViewsOf(
          ports.db,
          "people",
          neighbours.filter((other) => other.conversationId === conversationId),
        ),
        publicationId: `${task.id}:task-deleted`,
      },
    ),
    announceNeighbours(ports, conversationId, neighbours, `${task.id}:task-deleted`),
  ]);
  return { tasks: [] };
}
