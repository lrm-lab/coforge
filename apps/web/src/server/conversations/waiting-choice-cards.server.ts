import { agentAvatarUrl } from "#src/features/agents/agent-mascot";
import type { ChannelVisibility } from "#src/features/conversations/channel-visibility";
import type { PrismaClient } from "#src/generated/prisma/client";
import { readableConversationWhere } from "./channel-read-access.server";

/** One pending choice card the viewer may answer, as the Activity "waiting" list shows it. */
export type WaitingChoiceCard = {
  messageId: string;
  conversationId: string;
  /** The channel the card is in; null in a direct conversation or a Task's. */
  channel: { name: string; visibility: ChannelVisibility } | null;
  /** The thread the card was posted in, when it is a reply. */
  threadRootId: string | null;
  /** The Task whose conversation the card is in: its number, and the channel it is on. */
  task: {
    conversationId: string;
    number: number;
    channel: { name: string; visibility: ChannelVisibility } | null;
  } | null;
  prompt: string;
  options: { id: string; label: string }[];
  preparedBy: { agentId: string; name: string; avatarUrl: string };
  createdAt: string;
};

/**
 * The pending choice cards this person may answer, newest first: a card that names them (its
 * `payload.to`, the card's own commit rule), in a conversation they can read.
 */
export async function waitingChoiceCards(
  db: Pick<PrismaClient, "actionCard">,
  workspaceId: string,
  userId: string,
): Promise<WaitingChoiceCard[]> {
  const cards = await db.actionCard.findMany({
    where: {
      workspaceId,
      kind: "choice",
      state: "pending",
      payload: { path: ["to"], equals: userId },
      conversation: readableConversationWhere(workspaceId, { userId }),
    },
    orderBy: { createdAt: "desc" },
    select: {
      messageId: true,
      conversationId: true,
      payload: true,
      createdAt: true,
      message: { select: { threadRootId: true } },
      conversation: {
        select: {
          channelName: true,
          visibility: true,
          taskDiscussionOf: {
            select: {
              conversationId: true,
              number: true,
              conversation: { select: { channelName: true, visibility: true } },
            },
          },
        },
      },
      preparedByAgent: { select: { id: true, displayName: true, avatarMascot: true } },
    },
  });
  return cards.map((card) => {
    const payload = card.payload as { prompt?: string; options?: { id: string; label: string }[] };
    const { channelName, visibility, taskDiscussionOf } = card.conversation;
    const agent = card.preparedByAgent;
    return {
      messageId: card.messageId,
      conversationId: card.conversationId,
      channel: channelOf({ channelName, visibility }),
      threadRootId: card.message.threadRootId,
      task: taskDiscussionOf && {
        conversationId: taskDiscussionOf.conversationId,
        number: taskDiscussionOf.number,
        channel: channelOf(taskDiscussionOf.conversation),
      },
      prompt: payload.prompt ?? "",
      options: payload.options ?? [],
      preparedBy: {
        agentId: agent.id,
        name: agent.displayName,
        avatarUrl: agentAvatarUrl(agent.id, agent.avatarMascot),
      },
      createdAt: card.createdAt.toISOString(),
    };
  });
}

/** A channel's name and visibility; null for a direct conversation or a Task's. */
function channelOf(conversation: { channelName: string | null; visibility: string }) {
  return conversation.channelName
    ? { name: conversation.channelName, visibility: conversation.visibility as ChannelVisibility }
    : null;
}
