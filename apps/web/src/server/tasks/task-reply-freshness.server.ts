import type { AgentTaskReplyHeld } from "@lrm/coforge-sdk/agent";
import { HELD_CONTEXT_LIMIT } from "@lrm/coforge-sdk/internal";
import { agentMessageView } from "#src/server/conversations/agent-message-view.server";
import { MESSAGE_MENTIONS_SELECT } from "#src/server/conversations/mentions.server";
import type { Transaction } from "./task-board-ports.server";

export class TaskReplyHeld extends Error {
  constructor(readonly result: AgentTaskReplyHeld) {
    super("Task reply held for unread discussion");
  }
}

export async function checkTaskReplyFreshness(
  tx: Transaction,
  conversationId: string,
  agentId: string,
  taskId: string,
) {
  const member = await tx.conversationMember.findUnique({
    where: { conversationId_agentId: { conversationId, agentId } },
    select: { agentReadThroughSequence: true, id: true },
  });
  const where = {
    conversationId,
    threadRootId: null,
    sequence: { gt: member?.agentReadThroughSequence ?? 0 },
    senderMemberId: { not: null, ...(member ? { notIn: [member.id] } : {}) },
  };
  const pending = await tx.message.findMany({
    where,
    orderBy: { sequence: "desc" },
    take: HELD_CONTEXT_LIMIT + 1,
    select: { sequence: true, body: true, mentions: MESSAGE_MENTIONS_SELECT },
  });
  if (!pending.length) return;

  const heldMessages = pending
    .slice(0, HELD_CONTEXT_LIMIT)
    .reverse()
    .map((message) => {
      const { body } = agentMessageView(message);
      return {
        sequence: message.sequence,
        body: body.length > 240 ? `${body.slice(0, 240)}…` : body,
      };
    });
  const newMessageCount =
    pending.length > HELD_CONTEXT_LIMIT ? await tx.message.count({ where }) : pending.length;
  throw new TaskReplyHeld({
    state: "held",
    taskId,
    reason: "exact_target_pending",
    newMessageCount,
    omittedMessageCount: newMessageCount - heldMessages.length,
    heldMessages,
  });
}
