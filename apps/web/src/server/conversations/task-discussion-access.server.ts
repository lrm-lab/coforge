import { CHANNEL_VISIBILITY } from "#src/features/conversations/channel-visibility";

/**
 * What a person's read of a task's own conversation (`Conversation.kind` "task_thread") needs of
 * the board the task sits on: the conversation row has no channel, so the board decides, by the
 * rule that board's own conversation is read under. Select it with the person's member rows.
 */
export const taskDiscussionBoardSelect = (reader: { userId: string } | { agentId: string }) =>
  ({
    taskDiscussionOf: {
      select: {
        conversation: {
          select: {
            channelName: true,
            directKey: true,
            visibility: true,
            hiddenFromWorkspaceAt: true,
            members: { where: reader, select: { leftAt: true } },
          },
        },
      },
    },
  }) as const;

/**
 * A task conversation read by an Agent: only an active member of the board — the person's
 * public-channel rule does not apply to a reader who acts on Tasks by membership alone. */
export function taskDiscussionAgentAccess(discussion: {
  taskDiscussionOf: {
    conversation: Board & { channelName: string | null; members: { leftAt: Date | null }[] };
  } | null;
}): "read" | undefined {
  const board = discussion.taskDiscussionOf?.conversation;
  if (!board || board.hiddenFromWorkspaceAt) return undefined;
  if (!board.members.some((member) => member.leftAt === null)) return undefined;
  return board.channelName !== null ? "read" : undefined;
}

type Board = {
  channelName: string | null;
  directKey: string | null;
  visibility: string;
  hiddenFromWorkspaceAt: Date | null;
  members: { leftAt: Date | null }[];
};

/**
 * Whether the person reads the task conversation: a channel board they public or they are on it, or a
 * direct board they are an active member of. `"private"` is a private channel they are not in. A
 * seat in the task conversation itself (a follow) is never part of the answer: a person who lost
 * the board reads nothing, whatever seat they kept.
 */
export function taskDiscussionAccess(discussion: {
  taskDiscussionOf: { conversation: Board } | null;
}): "read" | "private" | undefined {
  const board = discussion.taskDiscussionOf?.conversation;
  if (!board || board.hiddenFromWorkspaceAt) return undefined;
  const onBoard = board.members.some((member) => member.leftAt === null);
  if (board.channelName !== null)
    return board.visibility === CHANNEL_VISIBILITY.PUBLIC || onBoard ? "read" : "private";
  return board.directKey !== null && onBoard ? "read" : undefined;
}
