import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import type { TaskExecutionSignal } from "@lrm/coforge-sdk/internal";
import { AgentDeliveryPublisher } from "#src/server/conversations/agent-delivery.server";
import type { ConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { allocateSequence } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { readTaskExecutionSignal } from "@lrm/coforge-sdk/internal";
import type { SelectedTask } from "./task-view.server";

type Recipient = { agentId: string; signal?: TaskExecutionSignal };
const executionOf = (task: SelectedTask) =>
  task.executionSessions.find(
    (session) => session.agentId === task.owner?.agentId && session.requestId,
  );

/** Only actionable transitions create deliveries; ordinary progress has no execution event. */
export async function writeTaskExecutionEvents(
  tx: Prisma.TransactionClient,
  before: SelectedTask,
  task: SelectedTask,
  failed = false,
): Promise<void> {
  const previous = executionOf(before);
  const current = executionOf(task);
  if (!previous && !current) return;
  const ended = failed || task.status === "done" || task.status === "closed";
  const changed = before.title !== task.title || before.description !== task.description;
  const handedBack =
    before.status !== task.status && ["in_review", "done", "closed"].includes(task.status);
  const recipients: Recipient[] = [];
  if (previous && (ended || before.ownerMemberId !== task.ownerMemberId))
    recipients.push({
      agentId: previous.agentId,
      signal: { executionSessionId: previous.id, attempt: previous.attempt, kind: "ended" },
    });
  if (changed && current && !ended)
    recipients.push({
      agentId: current.agentId,
      signal: { executionSessionId: current.id, attempt: current.attempt, kind: "changed" },
    });
  if (handedBack || failed) {
    const channel = await tx.conversation.findFirst({
      where: { id: task.conversationId, coordinatorAgent: ACTIVE_AGENT_WHERE },
      select: { coordinatorAgentId: true },
    });
    if (
      channel?.coordinatorAgentId &&
      channel.coordinatorAgentId !== task.owner?.agentId &&
      !recipients.some((recipient) => recipient.agentId === channel.coordinatorAgentId)
    )
      recipients.push({ agentId: channel.coordinatorAgentId });
  }
  const members = await tx.conversationMember.findMany({
    where: {
      conversationId: task.conversationId,
      agentId: { in: recipients.map((recipient) => recipient.agentId) },
      ...ACTIVE_MEMBER_WHERE,
    },
    select: { agentId: true },
  });
  const active = new Set(members.map((member) => member.agentId));
  const targets = recipients.filter((value) => active.has(value.agentId));
  if (!targets.length) return;
  const sequence = await allocateSequence(tx, task.conversationId);
  await tx.message.create({
    data: {
      workspaceId: task.workspaceId,
      conversationId: task.conversationId,
      threadRootId: task.messageId,
      sequence,
      body: changed
        ? `Task #${task.number} requirements changed (revision ${task.revision}).\n${task.title}\n${task.description ?? ""}`
        : `Task #${task.number} ${failed ? "execution failed" : `is ${task.status}`}${before.ownerMemberId !== task.ownerMemberId ? "; its previous execution ended" : ""}. Inspect this task's evidence and decide the next step; no acknowledgement is needed.`,
      deliveries: {
        create: targets.map((recipient) => ({
          workspaceId: task.workspaceId,
          conversationId: task.conversationId,
          agentId: recipient.agentId,
          sequence,
          ...(recipient.signal
            ? {
                taskExecutionSessionId: recipient.signal.executionSessionId,
                taskExecutionSignal: recipient.signal,
              }
            : {}),
        })),
      },
    },
  });
}

/** PostgreSQL retains delivery eligibility across missed publications and daemon reconnects. */
export async function publishTaskExecutionEvents(
  db: PrismaClient,
  publisher: Pick<CentrifugoServerApi, "publish"> | undefined,
  task: SelectedTask,
  realtime?: ConversationRealtime,
): Promise<void> {
  if (!publisher) return;
  const rows = await db.agentMessageDelivery.findMany({
    where: {
      conversationId: task.conversationId,
      receivedAt: null,
      message: { threadRootId: task.messageId, senderMemberId: null },
    },
    include: {
      agent: { select: { computerId: true } },
      message: true,
      conversation: { select: { channelName: true } },
    },
  });
  await Promise.allSettled(
    rows.map((row) =>
      realtime?.messageAvailable({
        workspaceId: task.workspaceId,
        conversationId: task.conversationId,
        messageId: row.messageId,
        sequence: row.message.sequence,
        publicationId: `${row.messageId}:task-execution`,
      }),
    ),
  );
  await new AgentDeliveryPublisher(publisher).publish(
    task.workspaceId,
    rows.map((row) => ({
      computerId: row.agent.computerId,
      workspaceId: task.workspaceId,
      requestId: row.messageId,
      conversationId: task.conversationId,
      messageId: row.messageId,
      deliveryId: row.deliveryId,
      agentId: row.agentId,
      sequence: row.message.sequence,
      createdAtMs: row.message.createdAt.getTime(),
      body: row.message.body,
      mentions: [],
      target: `#${row.conversation.channelName}:${task.messageId}`,
      latestSenderKind: "system",
      latestSenderHandle: "",
      latestSenderDescription: "",
      ...(row.taskExecutionSignal
        ? { taskExecutionSignal: readTaskExecutionSignal(row.taskExecutionSignal) }
        : {}),
    })),
  );
}
