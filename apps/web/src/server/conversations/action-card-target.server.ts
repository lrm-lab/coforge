import { isChannelMessageTarget } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { getAgentChannel, resolveChannelThreadRoot } from "./public-channels.server";

/**
 * The narrow slice of `DirectConversationRepository` an action card needs to resolve a `@user` DM
 * target.
 */
export type ActionCardTargetRepository = {
  userIdForUsername(target: string): Promise<string>;
  getOrCreateUserAgent(
    workspaceId: string,
    userId: string,
    agentId: string,
  ): Promise<{ id: string }>;
};

/** Where an Agent posts an action card: the same target grammar and membership rules as Agent
 * `message send` (see `direct-message.server.ts`). */
export async function resolveActionCardTarget(
  db: PrismaClient,
  conversations: ActionCardTargetRepository,
  workspaceId: string,
  agentId: string,
  target: string,
) {
  const [parentTarget, anchor, extra] = target.split(":");
  if (!parentTarget || extra !== undefined) throw new AppError("INVALID_INPUT");
  // A channel thread's anchor is eight hex characters or the whole id, as for `message send`;
  // a shorter prefix that happens to be unique still names no thread.
  if (parentTarget.startsWith("#") && anchor !== undefined && !isChannelMessageTarget(target))
    throw new AppError("INVALID_INPUT");
  const conversationId = parentTarget.startsWith("#")
    ? (await getAgentChannel(db, workspaceId, agentId, parentTarget)).id
    : (
        await conversations.getOrCreateUserAgent(
          workspaceId,
          await conversations.userIdForUsername(target),
          agentId,
        )
      ).id;
  const threadRootId = anchor
    ? (await resolveChannelThreadRoot(db, conversationId, anchor)).id
    : undefined;
  const member = await db.conversationMember.findFirst({
    where: { conversationId, agentId },
    select: { id: true },
  });
  if (!member) throw new AppError("ACCESS_DENIED");
  return { conversationId, threadRootId, senderMemberId: member.id };
}

export type ActionCardTarget = Awaited<ReturnType<typeof resolveActionCardTarget>>;
