import type { PrismaClient } from "#src/generated/prisma/client";
import { CHANNEL_VISIBILITY } from "#src/features/conversations/channel-visibility";
import { isPeopleDirectKey, peopleDirectKeyPair } from "#src/features/conversations/direct-key";
import { readConversationSignalParticipants } from "#src/server/db/repositories/conversation-signal.repositories.server";
import { errorType } from "#src/server/errors/error-type.server";

/**
 * The realtime fan-out scope for one conversation's messages. A channel message goes
 * to the Workspace signal channel; a direct message goes only to its people's own channels — a
 * User–Agent one to its human viewer, naming the Agent, one between people to each member —
 * so DM metadata never reaches the Workspace. A direct conversation that is neither (unreachable
 * through the supported create paths) falls back to the Workspace channel rather than silently
 * publishing nowhere. `memberUserIds` is a private channel's Task scope only (see
 * `conversationSignalScopes`).
 */
export type MessageSignalScope = {
  workspaceId?: string;
  userId?: string;
  agentId?: string;
  directUserIds?: readonly string[];
  directPair?: readonly [string, string];
  memberUserIds?: readonly string[];
};

/** Who hears of a channel's change: for a private channel, its active people, each on their own
 * channel (`memberUserIds`); for a public one nobody by name (`undefined`), as the Workspace
 * channel carries it. The key is required, so an announcement that forgets it does not compile. */
export type ChannelAudience = { memberUserIds: readonly string[] | undefined };

export async function messageSignalScope(
  db: PrismaClient,
  conversationId: string,
  workspaceId: string,
): Promise<MessageSignalScope> {
  return (await conversationSignalScopes(db, conversationId, workspaceId)).message;
}

/**
 * Where a conversation's signals go, read once: `message` as `messageSignalScope` says, and `task`
 * for its Task announcements, which carry Task content and so never take the Workspace fallback:
 * a private channel announces its Tasks to its active people only, and one with none of them, or
 * a direct conversation that is neither User–Agent nor between people, announces them nowhere.
 */
export async function conversationSignalScopes(
  db: PrismaClient,
  conversationId: string,
  workspaceId: string,
): Promise<{ message: MessageSignalScope; task?: MessageSignalScope }> {
  const conversation = await readConversationSignalParticipants(db, conversationId);
  if (!conversation) return { message: { workspaceId } };
  if (conversation.channelName !== null) {
    if (conversation.visibility !== CHANNEL_VISIBILITY.PRIVATE)
      return { message: { workspaceId }, task: { workspaceId } };
    const memberUserIds = userIdsOf(conversation.members);
    return memberUserIds.length
      ? { message: { workspaceId }, task: { workspaceId, memberUserIds } }
      : { message: { workspaceId } };
  }
  // The key says what kind of direct conversation it is (`user:<a>|user:<b>` between people);
  // its remaining member rows say who still gets its signals.
  if (conversation.directKey && isPeopleDirectKey(conversation.directKey)) {
    const directUserIds = userIdsOf(conversation.members);
    const directPair = peopleDirectKeyPair(conversation.directKey);
    return directUserIds.length
      ? {
          message: { directUserIds, directPair },
          task: { workspaceId, directUserIds, directPair },
        }
      : { message: {} };
  }
  const userId = conversation.members.find((member) => member.userId)?.userId;
  const agentId = conversation.members.find((member) => member.agentId)?.agentId;
  return userId && agentId
    ? { message: { userId, agentId }, task: { workspaceId, userId, agentId } }
    : { message: { workspaceId } };
}

/** A channel's `ChannelAudience`; a private one's people are read before a change is announced
 * (before a delete, too). A private channel that is gone, or whose read fails, names nobody, so
 * the change is announced to no one rather than to all, and never fails the write it follows. */
export async function channelAudience(
  db: PrismaClient,
  channel: { id: string; visibility: string },
): Promise<ChannelAudience> {
  if (channel.visibility !== CHANNEL_VISIBILITY.PRIVATE) return { memberUserIds: undefined };
  const read = await readConversationSignalParticipants(db, channel.id).catch((error: unknown) => {
    console.warn(
      JSON.stringify({ event: "channel_audience:read_failed", error_type: errorType(error) }),
    );
    return null;
  });
  return { memberUserIds: read ? userIdsOf(read.members) : [] };
}

function userIdsOf(members: readonly { userId: string | null }[]) {
  return members.flatMap((member) => (member.userId ? [member.userId] : []));
}
