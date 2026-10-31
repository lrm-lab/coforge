import type { ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";

/** What an Activity row names before its latest message (`activityRowPlace`). */
export type ActivityRowPlace = { kind: "attachment"; fileName: string } | { kind: "conversation" };

/**
 * What an Activity row's second line names before its latest message: the file a comment is on,
 * whether the comment starts a thread or not, else the conversation a thread or a Task is in.
 * Nothing for a conversation's own row, whose title already is the place.
 */
export function activityRowPlace({
  attachmentComment,
  thread,
  task,
}: Pick<ActivityInboxItem, "attachmentComment" | "thread" | "task">): ActivityRowPlace | undefined {
  if (attachmentComment) return { kind: "attachment", fileName: attachmentComment.fileName };
  return thread || task ? { kind: "conversation" } : undefined;
}
