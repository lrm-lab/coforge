import type { ForwardCopy } from "#src/server/conversations/message-forward-view.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AGENT_FORWARD_SELECT } from "./direct-conversation-agent-message.server";

export const AGENT_RECOVERY_MESSAGE_LIMIT = 100;

export type AgentRecoveryRow = {
  id: string;
  sequence: number;
  body: string;
  conversationId: string;
  threadRootId: string | null;
  senderMemberId: string | null;
  createdAt: Date;
  deliveryId: string | null;
  senderAgentName: string | null;
  senderAgentDescription: string | null;
  senderUsername: string | null;
  senderUserDescription: string | null;
  channelName: string | null;
  otherUsername: string | null;
  agentPeer: boolean;
  unreadCount: number;
  globalRank: number;
  nonMemberMention: boolean;
  attachmentId: string | null;
  conversationKind?: string | null;
  directKey?: string | null;
  appKey?: string | null;
};

export async function recoverySecondPass(
  db: Pick<PrismaClient, "messageMention" | "messageForward">,
  rows: readonly Pick<AgentRecoveryRow, "id">[],
) {
  const ids = rows.map((row) => row.id);
  const [mentionRows, forwardRows] = rows.length
    ? await Promise.all([
        db.messageMention.findMany({
          where: { messageId: { in: ids } },
          select: { messageId: true, kind: true, actorId: true, handle: true },
        }),
        db.messageForward.findMany({
          where: { messageId: { in: ids } },
          orderBy: { position: "asc" },
          select: {
            messageId: true,
            ...AGENT_FORWARD_SELECT.select,
            message: {
              select: {
                attachments: {
                  select: { id: true, forwardPosition: true },
                  orderBy: { position: "asc" },
                },
              },
            },
          },
        }),
      ])
    : [[], []];
  const mentionsByMessage = new Map<string, { kind: string; actorId: string; handle: string }[]>();
  for (const mention of mentionRows) {
    const list = mentionsByMessage.get(mention.messageId) ?? [];
    list.push(mention);
    mentionsByMessage.set(mention.messageId, list);
  }
  return {
    mentionsByMessage,
    forwardsByMessage: groupForwards(forwardRows),
  };
}

function groupForwards<T extends { messageId: string; message: { attachments: ForwardCopy[] } }>(
  rows: readonly T[],
): Map<string, { forwards: T[]; attachments: ForwardCopy[] }> {
  const byMessage = new Map<string, { forwards: T[]; attachments: ForwardCopy[] }>();
  for (const row of rows) {
    const entry = byMessage.get(row.messageId);
    if (entry) entry.forwards.push(row);
    else byMessage.set(row.messageId, { forwards: [row], attachments: row.message.attachments });
  }
  return byMessage;
}
