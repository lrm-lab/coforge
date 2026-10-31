import { announceMessageBestEffort } from "#src/server/conversations/conversation-activity.server";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import { channelActorOf } from "#src/server/conversations/channel-actor.server";
import { userUploadedAttachmentWhere } from "#src/server/attachments/message-attachments.server";
import { assertCanAssignOther } from "./task-assignment-authority.server";
import type { TaskCommand, TaskPrincipal } from "@lrm/coforge-sdk/internal";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { AppError } from "#src/lib/app-error";
import { conversationSignalScopes } from "#src/server/conversations/conversation-signal-scope.server";
import { MESSAGE_MENTIONS_SELECT } from "#src/server/conversations/mentions.server";
import { storeMessageBody } from "#src/server/conversations/message-references.server";
import {
  agentMessageSender,
  MESSAGE_SENDER_SELECT,
} from "#src/server/conversations/sender-display.server";
import { assigneeMention, noticeActor, noticeText } from "./task-notices.server";
import { DUPLICATE_TASK_WINDOW_MS, normalizeTaskTitle } from "./task-command-validation.server";
import { creationChanges, historyRows } from "./task-history.server";
import {
  hostMessageId,
  taskSelection,
  taskView,
  UNFINISHED_TASK_STATUSES,
  type SelectedTask,
} from "./task-view.server";
import type { TaskBoardPorts, Member, ConversationRef } from "./task-board-ports.server";
import { ensureTaskExecutionSession } from "./task-change.server";
import { withNotices } from "./task-notice-posting.server";
import {
  signalTaskChange,
  announceTasks,
  publishDeliveries,
  publishAssignmentReceipt,
} from "./task-publication.server";
import { receiptAssignee, assigneeMember } from "./task-assignees.server";
import { indexedRequestId } from "./task-request-ids.server";

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
      indexedRequestId(`${member.id}:create:${command.idempotencyKey}:assignment`, index + 1),
    ),
  );
  const result = await withNotices(ports, scope, async (tx, notices) => {
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
          creatorMemberId: { not: member.id },
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
          select: { agentId: true, channelMuted: true },
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
        ({ agentId, channelMuted }) =>
          mentionedAgentIds.has(agentId!) ||
          (coordinator?.coordinatorAgentId
            ? agentId === coordinator.coordinatorAgentId
            : !scope.channel || !channelMuted),
      );
      // The Task's id is its message's, as for every Task that started as a message.
      const messageId = Bun.randomUUIDv7();
      const message = await tx.message.create({
        data: {
          id: messageId,
          conversationId: scope.conversationId,
          workspaceId: scope.workspaceId,
          senderMemberId: member.id,
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
              id: messageId,
              workspaceId: scope.workspaceId,
              number: firstTaskNumber + index,
              // The Task's title is its message's stored body, as a converted Task's is; `view`
              // reads its tokens back as text with the message's mention rows.
              title: stored.body,
              description: command.description,
              createsResource: command.createsResource ?? false,
              ownerMemberId: assignee?.id,
              status: started ? "in_progress" : "todo",
              claimedAt: started ? new Date() : null,
              creatorMemberId: member.id,
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
      if (assignee?.agentId) {
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
    await tx.taskHistoryEvent.createMany({
      data: tasks.flatMap((task) => historyRows(task.id, member, creationChanges(task), 0)),
    });
    const quoted = await notices.quote(tasks);
    await notices.inConversation(noticeText.created(quoted));
    // The assignee's receipts, started or only reserved: one assignment notice in each Task's
    // thread, with its fixed id and its one delivery to an Agent assignee that is not the
    // creator.
    const receipts = [];
    if (assignee)
      for (const [index, task] of tasks.entries())
        receipts.push(
          await notices.receipt({
            id: receiptIds[index]!,
            task,
            body: (subject) =>
              noticeText.assigned(
                noticeActor(member).displayName,
                subject,
                assigneeMention(assignee),
              ),
            assignee,
            actor: member,
          }),
        );
    return {
      tasks,
      created: true,
      sequences,
      receipts,
      assigneeHandle: assignee ? assigneeMention(assignee) : null,
      started,
    };
  });
  if (result.created) {
    // Committed Tasks survive notification/realtime/daemon failure through normal recovery.
    // Catch each effect immediately, including while delivery rows are still being read.
    const attempt = (effect: () => unknown) =>
      Promise.resolve()
        .then(effect)
        .catch(() => undefined);
    const scopes = await conversationSignalScopes(
      ports.db,
      scope.conversationId,
      scope.workspaceId,
    );
    const signalScope = scopes.message;
    const effects: Promise<unknown>[] = [
      announceTasks(ports, scope, async () => scopes.task, {
        tasks: result.tasks.map((task) => taskView(task, "people")),
        publicationId: `${result.tasks[0]!.id}:task-created`,
      }),
    ];
    effects.push(
      ...result.tasks.flatMap((task, index) => [
        ...(member.userId
          ? [attempt(() => ports.dependencies.notifications?.notifyMessage(hostMessageId(task)))]
          : []),
        attempt(() =>
          announceMessageBestEffort(ports.db, ports.dependencies.realtime, {
            conversationId: scope.conversationId,
            messageId: hostMessageId(task),
            sequence: result.sequences[index]!,
            ...signalScope,
            ...(member.userId ? { senderUserId: member.userId } : {}),
          }),
        ),
      ]),
    );
    if (member.userId && ports.dependencies.publisher) {
      const messages = await ports.db.message.findMany({
        where: { id: { in: result.tasks.map((task) => hostMessageId(task)) } },
        include: {
          sender: MESSAGE_SENDER_SELECT,
          mentions: MESSAGE_MENTIONS_SELECT,
          deliveries: { include: { agent: { select: { computerId: true } } } },
        },
      });
      for (const message of messages) {
        const sender = agentMessageSender(message.sender);
        effects.push(
          publishDeliveries(
            ports,
            message,
            command.idempotencyKey,
            scope.channelName ? `#${scope.channelName}` : `@${sender.handle}`,
            sender,
          ),
        );
      }
    }
    await Promise.all(effects);
    // One delivery per Task's receipt, each its own daemon request: the receipt's id is stable
    // across retries, as the command's key is for a single one.
    await Promise.all(
      result.receipts.map((receipt) => publishAssignmentReceipt(ports, receipt.id, receipt.id)),
    );
  }
  const { receipts } = result;
  return {
    tasks: result.tasks.map((task) => taskView(task, ports.reader)),
    ...(result.held ? { state: "held" as const } : {}),
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

/**
 * Publish a sentMessageBecomesTask notice and Task change like create; its fixed notice id
 * makes retries idempotent.
 */
export async function announceSentMessageTask(
  ports: TaskBoardPorts,
  conversation: ConversationRef,
  messageId: string,
) {
  const noticeId = await indexedRequestId(`${messageId}:sent-as-task`, 1);
  const task = await withNotices(ports, conversation, async (tx, notices) => {
    const task = await tx.task.findUnique({ where: { messageId }, select: taskSelection });
    if (!task || task.conversationId !== conversation.conversationId)
      throw new AppError("NOT_FOUND");
    if (!(await tx.message.findUnique({ where: { id: noticeId }, select: { id: true } })))
      await notices.inConversation(noticeText.created(await notices.quote([task])), noticeId);
    return task;
  });
  await signalTaskChange(ports, task);
}
