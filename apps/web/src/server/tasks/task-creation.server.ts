import { isMutedLevel } from "#src/server/conversations/notification-level.server";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import { channelActorOf } from "#src/server/conversations/channel-actor.server";
import { userUploadedAttachmentWhere } from "#src/server/attachments/message-attachments.server";
import { assertCanAssignOther } from "./task-assignment-authority.server";
import type { TaskCommand, TaskHistoryChange, TaskPrincipal } from "@lrm/coforge-sdk/internal";
import { taskStatusNeedsOwner } from "@lrm/coforge-sdk/internal";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { AppError } from "#src/lib/app-error";
import {
  storeMessageBody,
  writeMessageReferences,
} from "#src/server/conversations/message-references.server";
import { assigneeMention, noticeText } from "./task-notices.server";
import { DUPLICATE_TASK_WINDOW_MS, normalizeTaskTitle } from "./task-command-validation.server";
import { creationChanges, historyRows } from "./task-history.server";
import {
  LIVE_TASK_WHERE,
  taskSelection,
  UNFINISHED_TASK_STATUSES,
  type SelectedTask,
} from "./task-view.server";
import type { TaskBoardPorts, Member } from "./task-board-ports.server";
import { memberId } from "./task-board-ports.server";
import { ensureTaskExecutionSession } from "./task-change.server";
import { linkCreatedTasks } from "./task-gates.server";
import { taskViewsOf } from "./task-relations.server";
import { withNotices } from "./task-notice-posting.server";
import { publishCreatedTasks } from "./task-creation-publication.server";
import { receiptAssignee, assigneeMember } from "./task-assignees.server";
import { indexedRequestId } from "./task-request-ids.server";
import { assignmentReceipts } from "./task-assignment.server";
import { LABELS_PER_TASK_MAX, labelsChange, labelView, resolveTaskLabels } from "./labels.server";
import { resolveNewTaskProject } from "./task-projects.server";
import { resolveTaskParent } from "./task-relations-write.server";

export async function createTasks(
  ports: TaskBoardPorts,
  scope: {
    conversationId: string;
    workspaceId: string;
    channel: boolean;
    channelName: string | null;
  },
  member: Member,
  principal: TaskPrincipal,
  command: TaskCommand,
) {
  const titles = (command.titles ?? [command.title!]).map((title) => title.trim());
  const requestIds = await Promise.all(
    titles.map((_, index) => indexedRequestId(command.idempotencyKey, index)),
  );
  // One receipt per Task, in its own thread; the first keeps the id a single receipt had.
  const receiptIds = await Promise.all(
    titles.map((_, index) =>
      indexedRequestId(
        `${memberId(member)}:create:${command.idempotencyKey}:assignment`,
        index + 1,
      ),
    ),
  );
  const result = await withNotices(ports, scope, async (tx, notices) => {
    const retried = await tx.task.findMany({
      where: {
        conversationId: scope.conversationId,
        creatorMemberId: memberId(member),
        requestId: { in: requestIds },
      },
      orderBy: { number: "asc" },
      select: taskSelection,
    });
    if (retried.length) {
      if (retried.length !== titles.length) throw new AppError("CONFLICT");
      const receipts = await tx.message.findMany({
        where: { id: { in: receiptIds } },
        orderBy: { sequence: "asc" },
      });
      const assigned = receipts[0] ? await receiptAssignee(tx, receipts[0].id) : null;
      return {
        tasks: retried,
        created: false,
        sequences: [] as number[],
        receipts,
        assigneeHandle: assigned?.handle ?? null,
        started: assigned?.memberId === member.id,
      };
    }
    // A repeated single create is a likely race. A batch is an explicit decomposition request;
    // holding the whole batch because one title matches would discard its genuinely new tasks.
    if (principal.agentId && titles.length === 1) {
      const duplicateCandidates = await tx.task.findMany({
        where: {
          conversationId: scope.conversationId,
          creatorMemberId: { not: memberId(member) },
          ...LIVE_TASK_WHERE,
          status: { in: UNFINISHED_TASK_STATUSES },
          createdAt: { gte: new Date(Date.now() - DUPLICATE_TASK_WINDOW_MS) },
        },
        orderBy: { createdAt: "asc" },
        select: taskSelection,
      });
      const duplicate = duplicateCandidates.find(
        (candidate) => normalizeTaskTitle(candidate.title) === normalizeTaskTitle(titles[0]!),
      );
      if (duplicate)
        return {
          tasks: [duplicate],
          created: false,
          held: true,
          sequences: [] as number[],
          receipts: [],
          assigneeHandle: null,
          started: false,
        };
    }
    if (command.attachmentId) {
      if (!principal.userId) throw new AppError("ACCESS_DENIED");
      const attachment = await tx.attachment.findFirst({
        where: {
          id: command.attachmentId,
          conversationId: scope.conversationId,
          workspaceId: scope.workspaceId,
          ...userUploadedAttachmentWhere(principal.userId),
          messageId: null,
        },
      });
      if (!attachment) throw new AppError("ACCESS_DENIED");
    }
    // The Project the new Tasks are filed under (task #484): the one named, a sub-task's
    // parent's, else this member's last-used one here.
    const parent = await resolveTaskParent(tx, scope, member, command.parent, []);
    const project = await resolveNewTaskProject(tx, scope, member, command, parent);
    // The labels the new Tasks carry, resolved before anything is written; an unknown name is
    // refused with the Workspace's own labels. A Task carries at most five.
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
    // One statement takes the conversation lock and allocates both counters: a batch's Task
    // numbers and its message sequences. `lastSequence` is the sole source; `MAX(sequence)`
    // only floors a lagging counter, as in `allocateSequences`.
    const allocated = await tx.$queryRaw<Array<{ first: number; firstSequence: number }>>`
        UPDATE "conversations"
        SET "nextTaskNumber" = "nextTaskNumber" + ${titles.length},
            "lastSequence" = GREATEST(
              "lastSequence",
              (SELECT COALESCE(MAX("sequence"), 0) FROM "messages" WHERE "conversationId" = "conversations"."id")
            ) + ${titles.length}
        WHERE "id" = ${scope.conversationId}::uuid
        RETURNING "nextTaskNumber" - ${titles.length} AS "first",
                  "lastSequence" - ${titles.length} + 1 AS "firstSequence"
      `;
    const firstTaskNumber = allocated[0]?.first;
    const firstSequence = allocated[0]?.firstSequence;
    if (firstTaskNumber === undefined || firstSequence === undefined)
      throw new AppError("NOT_FOUND");
    // Human Tasks wake live Agents: the DM Agent, or unmuted channel Agents (coordinator only
    // when configured), plus muted Agents mentioned in the title. Agent Tasks wake nobody.
    const agentMembers = member.userId
      ? await tx.conversationMember.findMany({
          where: {
            conversationId: scope.conversationId,
            agentId: { not: null },
            ...ACTIVE_MEMBER_WHERE,
            agent: ACTIVE_AGENT_WHERE,
          },
          select: { agentId: true, notificationLevel: true },
        })
      : [];
    const coordinator =
      member.userId && scope.channel
        ? await tx.conversation.findFirst({
            where: {
              id: scope.conversationId,
              coordinatorAgentId: { not: null },
              coordinatorAgent: ACTIVE_AGENT_WHERE,
            },
            select: { coordinatorAgentId: true },
          })
        : null;
    // A title is a message like any other: its mentions, `task #N`s and `#channel`s are stored as
    // tokens, resolved against the channel's active members (a DM keeps plain `@handle` text).
    const mentionTargets = scope.channel
      ? (
          await tx.conversationMember.findMany({
            where: { conversationId: scope.conversationId, ...ACTIVE_MEMBER_WHERE },
            select: {
              id: true,
              userId: true,
              agentId: true,
              user: { select: { username: true } },
              agent: { select: { name: true } },
            },
          })
        ).map((target) =>
          target.userId
            ? {
                key: target.id,
                type: "user" as const,
                id: target.userId,
                handle: target.user!.username,
              }
            : {
                key: target.id,
                type: "agent" as const,
                id: target.agentId!,
                handle: target.agent!.name,
              },
        )
      : [];
    const assignee = command.assignee
      ? await assigneeMember(tx, scope.conversationId, scope.workspaceId, command.assignee)
      : null;
    if (command.assignee && !assignee) throw new AppError("NOT_FOUND");
    if (assignee && assignee.id !== member.id)
      await assertCanAssignOther(tx, scope.workspaceId, member);
    const started = assignee?.id === member.id;
    // An initial status the command named (task #61): the column a board form was opened from, or
    // an Agent's explicit pick. The defaults stay: a self-assign starts in progress, anything
    // else waits in todo — an explicit status only says where the new Task waits instead.
    const initial = command.status === "all" ? undefined : command.status;
    if (initial && taskStatusNeedsOwner(initial) && !assignee)
      throw new AppError("CONFLICT", {
        hint: `a Task in ${initial} needs an owner; assign it or create it in todo`,
      });
    if (initial && command.createsResource && initial !== "todo") throw new AppError("CONFLICT");
    // "Claimed" is today's started: the creator took the Task themselves and it begins in
    // progress. An explicit status defers to itself — a self-assign parked in another column is
    // held, not started.
    const claimed = started && (initial === undefined || initial === "in_progress");
    const initialStatus = initial ?? (started ? "in_progress" : "todo");
    const tasks: SelectedTask[] = [];
    const sequences: number[] = [];
    for (const [index, title] of titles.entries()) {
      const sequence = firstSequence + index;
      const stored = await storeMessageBody(
        tx,
        { ...scope, reader: channelActorOf(member) },
        title,
        { targets: mentionTargets },
      );
      const mentionedAgentIds = new Set(
        stored.mentions.filter((mention) => mention.type === "agent").map((mention) => mention.id),
      );
      // Mentions broaden the audience. A muted assignee gets one assignment receipt below,
      // regardless of how many created Tasks it holds.
      const recipients = agentMembers.filter(
        ({ agentId, notificationLevel }) =>
          mentionedAgentIds.has(agentId!) ||
          (coordinator?.coordinatorAgentId
            ? agentId === coordinator.coordinatorAgentId
            : !scope.channel || !isMutedLevel(notificationLevel)),
      );
      // The Task's id is its own — `task.messageId` names the message the Task started from.
      // The message and the Task get separate uuid(7)s: a reclaimed message's prior Task kept
      // `task.id === message.id`, and a fresh task.id keeps that old Task's references and
      // realtime keys off the new one (task #507).
      const messageId = Bun.randomUUIDv7();
      const taskId = Bun.randomUUIDv7();
      const message = await tx.message.create({
        data: {
          id: messageId,
          conversationId: scope.conversationId,
          workspaceId: scope.workspaceId,
          senderMemberId: memberId(member),
          body: stored.body,
          sequence,
          mentions: stored.mentions.length
            ? {
                create: stored.mentions.map((mention) => ({
                  memberId: mention.key,
                  workspaceId: scope.workspaceId,
                  kind: mention.type,
                  actorId: mention.id,
                  handle: mention.handle,
                })),
              }
            : undefined,
          deliveries: {
            create: recipients.map(({ agentId }) => ({
              workspaceId: scope.workspaceId,
              conversationId: scope.conversationId,
              agentId: agentId!,
              sequence,
            })),
          },
          task: {
            create: {
              id: taskId,
              workspaceId: scope.workspaceId,
              number: firstTaskNumber + index,
              projectId: project?.id,
              // The Task's title is its message's stored body, as a converted Task's is; `view`
              // reads its tokens back as text with the message's mention rows.
              title: stored.body,
              description: command.description,
              createsResource: command.createsResource ?? false,
              priority: command.priority,
              ownerMemberId: assignee?.id,
              status: initialStatus,
              claimedAt: claimed ? new Date() : null,
              creatorMemberId: memberId(member),
              requestId: requestIds[index],
            },
          },
        },
        select: { id: true, task: { select: taskSelection } },
      });
      // Task creation stays single-attachment (out of scope for the multi-attachment change);
      // only the first created message (when titles.length > 1) may carry the one attachment.
      if (index === 0 && command.attachmentId)
        await tx.attachment.update({
          where: { id: command.attachmentId },
          data: { messageId: message.id, position: 0 },
        });
      await writeMessageReferences(tx, message, scope, stored.references);

      if (assignee?.agentId && claimed) {
        await ensureTaskExecutionSession(tx, message.task!, assignee.agentId);
        tasks.push(
          await tx.task.findUniqueOrThrow({
            where: { id: message.task!.id },
            select: taskSelection,
          }),
        );
      } else tasks.push(message.task!);
      sequences.push(sequence);
    }
    if (labels.length)
      await tx.taskLabel.createMany({
        data: tasks.flatMap((task) =>
          labels.map((label) => ({ taskId: task.id, labelId: label.id })),
        ),
      });
    const labelsAdded = labelsChange(labels.map(labelView), []);
    const projectAdded: TaskHistoryChange | null = project
      ? { eventType: "project_changed", payload: { from: null, to: project } }
      : null;
    await tx.taskHistoryEvent.createMany({
      data: tasks.flatMap((task) =>
        historyRows(
          task.id,
          member,
          [
            ...creationChanges(task),
            ...(labelsAdded ? [labelsAdded] : []),
            ...(projectAdded ? [projectAdded] : []),
          ],
          0,
        ),
      ),
    });
    await linkCreatedTasks(tx, scope, member, tasks, command);
    const quoted = await notices.quote(tasks);
    await notices.inConversation({
      body: noticeText.created(quoted),
      system: {
        kind: "task.created",
        params: { tasks: quoted.map(({ taskId, number, title }) => ({ taskId, number, title })) },
      },
    });
    // The assignee's receipts, started or only reserved: one assignment notice in each Task's
    // thread, with its fixed id and its one delivery to an Agent assignee that is not the
    // creator. Each carries the queue note `assign` would give it (task #716): a person's
    // create-and-assign is the same direct instruction.
    const receipts = assignee
      ? await assignmentReceipts(
          tx,
          notices,
          ports.reader,
          scope,
          member,
          assignee,
          tasks,
          receiptIds,
        )
      : [];
    return {
      tasks,
      created: true,
      sequences,
      receipts,
      assigneeHandle: assignee ? assigneeMention(assignee) : null,
      started,
    };
  });
  if (result.created) await publishCreatedTasks(ports, scope, member, command, result);
  const { receipts } = result;
  return {
    tasks: await taskViewsOf(ports.db, ports.reader, result.tasks),
    ...(result.held ? { state: "duplicate" as const } : {}),
    ...(receipts.length > 0 && {
      assignmentReceipts: receipts.map((receipt) => ({
        messageId: receipt.id,
        content: receipt.body,
        assignee: result.assigneeHandle ?? command.assignee!,
        state: result.started ? ("started" as const) : ("assigned" as const),
      })),
    }),
  };
}
