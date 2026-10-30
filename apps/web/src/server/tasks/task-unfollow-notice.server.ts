import { humanLabel } from "#src/lib/human-label";
import { withNotices } from "./task-notice-posting.server";
import type { TaskBoardPorts } from "./task-board-ports.server";
import { TASK_MEMBER_SELECT } from "./task-view.server";

/**
 * The line a task's conversation (or, for a task made from a message, that message's thread) shows
 * when someone stops following it, as a thread shows it. A reason is the follower's own words:
 * stored mention tokens in it are broken so it cannot forge a mention.
 */
export function unfollowNoticeBody(name: string, reason?: string) {
  const why = reason?.replace(/<@/g, "< @").trim();
  return `${name} stopped following this task${why ? `: ${why}` : ""}.`;
}

/**
 * Posts that line after a real unfollow. A task with neither a conversation nor a host message has
 * nowhere to show it, and making a conversation just for it would be noise.
 */
export async function postUnfollowNotice(
  ports: TaskBoardPorts,
  scope: { conversationId: string; workspaceId: string },
  task: {
    id: string;
    messageId: string | null;
    number: number;
    title: string;
    discussionConversationId: string | null;
  },
  memberId: string,
  reason?: string,
) {
  if (!task.messageId && !task.discussionConversationId) return;
  const member = await ports.db.conversationMember.findUnique({
    where: { id: memberId },
    select: TASK_MEMBER_SELECT,
  });
  const name = member?.user
    ? humanLabel(member.user)
    : member?.agent?.displayName?.trim() || member?.agent?.name || "Someone";
  await withNotices(ports, scope, (_tx, notices) =>
    notices.inThread(task, () => unfollowNoticeBody(name, reason)),
  );
}
