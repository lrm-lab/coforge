import type { ActivityConversationItem } from "#src/server/inbox/activity-inbox.server";

export type ActivityRowPlace = { kind: "attachment"; fileName: string } | { kind: "conversation" };

export function activityRowPlace({
  attachmentComment,
  thread,
  task,
}: Pick<ActivityConversationItem, "attachmentComment" | "thread" | "task">):
  | ActivityRowPlace
  | undefined {
  if (attachmentComment) return { kind: "attachment", fileName: attachmentComment.fileName };
  return thread || task ? { kind: "conversation" } : undefined;
}
