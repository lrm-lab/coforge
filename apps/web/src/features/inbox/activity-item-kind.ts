import type {
  ActivityConversationItem,
  ActivityInboxItem,
} from "#src/server/inbox/activity-inbox.server";
import type { ActivityItemDone } from "./activity-inbox.schemas";

export const canMarkUnread = (item: ActivityInboxItem): item is ActivityConversationItem =>
  item.kind === "conversation" && !item.thread && !item.task;

export function doneTarget(item: ActivityInboxItem): ActivityItemDone {
  if (item.kind === "artifact")
    return {
      kind: "artifact",
      artifactId: item.artifact.id,
      throughAt: new Date(item.at).getTime(),
    };
  if (item.mentionAction)
    return { kind: "mention_action", resolutionId: item.mentionAction.resolutionId };
  if (item.thread)
    return {
      kind: "thread",
      conversationId: item.place.conversationId,
      rootMessageId: item.thread.root.id,
      throughSequence: item.latestSequence,
    };
  return {
    kind: "conversation",
    conversationId: item.task?.conversationId ?? item.place.conversationId,
    throughSequence: item.latestSequence,
  };
}
