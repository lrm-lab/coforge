import type { PrismaClient } from "#src/generated/prisma/client";
import { visibleChannelWhere } from "#src/server/conversations/channel-read-access.server";
import type { ActivityCandidate } from "./activity-inbox.server";

/**
 * Each message whose sender had the viewer notified of a mention from outside its channel, until
 * the viewer marks it Done: one mention item per notification, listed from when it was sent,
 * unread until the viewer reads it. Not in a hidden or archived channel.
 */
export async function mentionCandidates(
  db: PrismaClient,
  workspaceId: string,
  userId: string,
): Promise<ActivityCandidate[]> {
  const [rows, commentRows] = await Promise.all([
    db.pendingMentionAction.findMany({
      where: {
        workspaceId,
        targetUserId: userId,
        notifiedAt: { not: null },
        dismissedAt: null,
        message: {
          conversation: { archivedAt: null, ...visibleChannelWhere(workspaceId, { userId }) },
        },
      },
      select: {
        id: true,
        conversationId: true,
        messageId: true,
        notifiedAt: true,
        targetReadAt: true,
        message: {
          select: {
            sequence: true,
            threadRootId: true,
            conversation: { select: { channelName: true } },
          },
        },
      },
    }),
    // A comment notification names its file's source conversation, not the comment
    // conversation (a comment conversation is no channel and no DM). The same recheck the
    // post applied: the viewer still reads the source — a channel by canReadChannel, a DM as
    // its active member — and neither hidden nor archived.
    db.pendingMentionAction.findMany({
      where: {
        workspaceId,
        targetUserId: userId,
        notifiedAt: { not: null },
        dismissedAt: null,
        message: {
          attachmentComment: {
            thread: {
              attachment: {
                conversation: {
                  hiddenFromWorkspaceAt: null,
                  archivedAt: null,
                  OR: [
                    {
                      channelName: { not: null },
                      OR: [
                        { visibility: "public" },
                        {
                          members: {
                            some: { workspaceId, userId, leftAt: null },
                          },
                        },
                      ],
                    },
                    {
                      channelName: null,
                      members: { some: { workspaceId, userId, leftAt: null } },
                    },
                  ],
                },
              },
            },
          },
        },
      },
      select: {
        id: true,
        conversationId: true,
        messageId: true,
        notifiedAt: true,
        targetReadAt: true,
        message: {
          select: {
            sequence: true,
            threadRootId: true,
            attachmentComment: {
              select: {
                attachmentId: true,
                thread: {
                  select: {
                    attachment: {
                      select: {
                        fileName: true,
                        messageId: true,
                        conversation: {
                          select: {
                            id: true,
                            channelName: true,
                            directKey: true,
                            members: {
                              where: { agentId: { not: null } },
                              select: { agentId: true },
                              take: 1,
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
  ]);
  return rows
    .map((row): ActivityCandidate => ({
      kind: "channel",
      memberId: "",
      conversationId: row.conversationId,
      rootMessageId: null,
      channelName: row.message.conversation.channelName,
      directKey: null,
      agentId: null,
      latestMessageId: row.messageId,
      latestSequence: row.message.sequence,
      latestAt: row.notifiedAt!,
      unreadCount: row.targetReadAt ? 0 : 1,
      firstUnreadMessageId: row.targetReadAt ? null : row.messageId,
      unreadMention: !row.targetReadAt,
      firstMentionMessageId: row.messageId,
      mentionAction: { resolutionId: row.id, threadRootId: row.message.threadRootId },
      pastDone: true,
      pin: null,
    }))
    .concat(
      commentRows.flatMap((row): ActivityCandidate[] => {
        const comment = row.message.attachmentComment;
        if (!comment) return [];
        const source = comment.thread.attachment.conversation;
        return [
          {
            kind: source.channelName ? "channel" : "direct",
            memberId: "",
            conversationId: source.id,
            rootMessageId: null,
            channelName: source.channelName,
            directKey: source.directKey,
            agentId: source.members[0]?.agentId ?? null,
            latestMessageId: row.messageId,
            latestSequence: row.message.sequence,
            latestAt: row.notifiedAt!,
            unreadCount: row.targetReadAt ? 0 : 1,
            firstUnreadMessageId: row.targetReadAt ? null : row.messageId,
            unreadMention: !row.targetReadAt,
            firstMentionMessageId: row.messageId,
            mentionAction: { resolutionId: row.id, threadRootId: null },
            attachmentComment: {
              attachmentId: comment.attachmentId,
              fileName: comment.thread.attachment.fileName,
              threadRootId: row.message.threadRootId,
              sourceMessageId: comment.thread.attachment.messageId,
            },
            pastDone: true,
            pin: null,
          },
        ];
      }),
    );
}
