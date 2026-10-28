import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import { ConversationHistory } from "./conversation-history.server";

export type MessageSeenByInput = {
  workspaceId: string;
  userId: string;
  conversationId: string;
  messageId: string;
};

export type MessageSeenBy = { kind: "user" | "agent"; id: string };

/** Readers of one of the viewer's own top-level messages, excluding the sender. */
export async function readMessageSeenBy(
  db: PrismaClient,
  input: MessageSeenByInput,
): Promise<{ seen: MessageSeenBy[] }> {
  const authorization = await new ConversationHistory(db).authorize(
    input.workspaceId,
    input.userId,
    input.conversationId,
  );
  if (!authorization.activeMemberId) throw new AppError("ACCESS_DENIED");

  const message = await db.message.findFirst({
    where: {
      id: input.messageId,
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      threadRootId: null,
    },
    select: { senderMemberId: true, sequence: true },
  });
  if (!message || message.senderMemberId !== authorization.activeMemberId)
    throw new AppError("NOT_FOUND");

  const members = await db.conversationMember.findMany({
    where: {
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      ...ACTIVE_MEMBER_WHERE,
      id: { not: authorization.activeMemberId },
    },
    select: {
      userId: true,
      agentId: true,
      readThroughSequence: true,
      agentReadThroughSequence: true,
    },
  });

  return {
    seen: members.flatMap((member) => {
      const id = member.agentId ?? member.userId;
      const readThrough = member.agentId
        ? member.agentReadThroughSequence
        : member.readThroughSequence;
      return id && readThrough >= message.sequence
        ? [{ kind: member.agentId ? ("agent" as const) : ("user" as const), id }]
        : [];
    }),
  };
}
