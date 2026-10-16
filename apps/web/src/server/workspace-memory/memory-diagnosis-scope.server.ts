import type { PrismaClient } from "#src/generated/prisma/client";
import { MESSAGE_MENTIONS_SELECT } from "#src/server/conversations/mentions.server";
import { agentMessageView } from "#src/server/conversations/agent-message-view.server";
import { isExplicitMemoryDiagnosis } from "./explicit-memory-answer";
import type { DiagnosisScope } from "./explicit-diagnosis";

const MAX_MESSAGES = 64;
const MAX_CHARACTERS = 64000;

/** Resolve a visible, task-authored message to a bounded diagnosis evidence scope. */
export async function resolveMemoryDiagnosisScope(
  db: PrismaClient,
  input: {
    workspaceId: string;
    agentId: string;
    messageId: string;
  },
): Promise<DiagnosisScope> {
  const { workspaceId, agentId, messageId } = input;
  const question = await db.message.findFirst({
    where: { id: messageId, workspaceId },
    select: {
      id: true,
      body: true,
      sequence: true,
      conversationId: true,
      threadRootId: true,
      mentions: MESSAGE_MENTIONS_SELECT,
      sender: { select: { agentId: true } },
      conversation: {
        select: { channelName: true, archivedAt: true, hiddenFromWorkspaceAt: true },
      },
    },
  });
  if (
    !question ||
    !question.sender?.agentId ||
    question.sender.agentId === agentId ||
    !question.conversation.channelName ||
    question.conversation.archivedAt ||
    question.conversation.hiddenFromWorkspaceAt
  )
    throw new Error("diagnosis_scope_denied");
  const targetAgentId = question.sender.agentId;
  const members = await db.conversationMember.count({
    where: {
      workspaceId,
      conversationId: question.conversationId,
      leftAt: null,
      agentId: { in: [agentId, targetAgentId] },
    },
  });
  if (members !== 2) throw new Error("diagnosis_scope_denied");
  const rows = await db.message.findMany({
    where: {
      workspaceId,
      conversationId: question.conversationId,
      sequence: { lte: question.sequence },
      ...(question.threadRootId
        ? { OR: [{ threadRootId: question.threadRootId }, { id: question.threadRootId }] }
        : { threadRootId: null }),
    },
    orderBy: { sequence: "desc" },
    take: MAX_MESSAGES,
    select: {
      id: true,
      body: true,
      createdAt: true,
      sender: { select: { agentId: true, agent: { select: { name: true } } } },
      mentions: MESSAGE_MENTIONS_SELECT,
    },
  });
  let remaining = MAX_CHARACTERS;
  const messages = [];
  for (const row of rows) {
    const content = agentMessageView(row).body;
    if (content.length > remaining) break;
    remaining -= content.length;
    messages.push({
      role: row.sender?.agentId ? ("assistant" as const) : ("user" as const),
      content,
      createdAt: row.createdAt.toISOString(),
      sourceMessageIds: [row.id],
      ...(row.sender?.agentId
        ? { peerId: `coforge__${row.sender.agent?.name ?? row.sender.agentId}` }
        : {}),
    });
  }
  if (!messages.length) throw new Error("diagnosis_evidence_budget_exceeded");
  const explicit = isExplicitMemoryDiagnosis(question.body, agentId);
  const state = agentMessageView(question).body;
  return {
    requestId: question.id,
    triggerKind: explicit ? "explicit_request" : "task_state",
    conversationId: question.conversationId,
    targetAgentId,
    question: explicit
      ? state.slice(0, 8192)
      : "Assess the Task's progress, evidence gaps and repeated failures from this bounded conversation snapshot. Build a four-role AIG and give grounded guidance; no verified task outcome is supplied. Task state: " +
        state.slice(0, 7900),
    messages: messages.reverse(),
  };
}
