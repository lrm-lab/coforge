import { getDatabaseClient } from "#src/server/db/client.server";

/** What a delivery's own rows can say about it, which its envelope otherwise cannot: the
 * message's system notice kind, and whether its conversation is a Task's discussion. */
export type DeliveryNoticeView = {
  /** `SystemMessage.kind`, e.g. "task.assigned_you". */
  noticeKind?: string;
  /** True when a Task names this conversation as its discussion. */
  taskDiscussion?: boolean;
};

/**
 * Reads the notice facts a batch of deliveries carries, keyed by message id and conversation id.
 *
 * Both come from the rows rather than from the target's shape: a Task's target (`#board:#N`) and a
 * channel thread's (`#board:<id>`) differ only in spelling, so reading the spelling would make a
 * task out of a thread whose id happens to be digits (raft, #coforge-backend:#14 seq 41). A
 * database that cannot answer leaves both out: the daemon then judges the delivery like any other
 * instead of being told something wrong.
 */
export async function deliveryNoticeViews(
  workspaceId: string,
  deliveries: readonly { messageId: string; conversationId: string }[],
): Promise<Map<string, DeliveryNoticeView>> {
  const db = getDatabaseClient();
  if (!db || deliveries.length === 0) return new Map();
  const messageIds = [...new Set(deliveries.map((delivery) => delivery.messageId))];
  const conversationIds = [...new Set(deliveries.map((delivery) => delivery.conversationId))];
  try {
    const [notices, discussions] = await Promise.all([
      db.systemMessage.findMany({
        where: { workspaceId, messageId: { in: messageIds } },
        select: { messageId: true, kind: true },
      }),
      db.task.findMany({
        where: { workspaceId, discussionConversationId: { in: conversationIds } },
        select: { discussionConversationId: true },
      }),
    ]);
    return noticeViewIndex(notices, discussions, deliveries);
  } catch {
    return new Map();
  }
}

/** The rows reduced to what each delivery says about itself: one entry per message that has
 * something to say, and nothing for the rest. */
export function noticeViewIndex(
  notices: readonly { messageId: string; kind: string }[],
  discussions: readonly { discussionConversationId: string | null }[],
  deliveries: readonly { messageId: string; conversationId: string }[],
): Map<string, DeliveryNoticeView> {
  const views = new Map<string, DeliveryNoticeView>();
  const kinds = new Map(notices.map((notice) => [notice.messageId, notice.kind]));
  const taskConversations = new Set(
    discussions.flatMap((task) =>
      task.discussionConversationId ? [task.discussionConversationId] : [],
    ),
  );
  for (const delivery of deliveries) {
    const noticeKind = kinds.get(delivery.messageId);
    const taskDiscussion = taskConversations.has(delivery.conversationId);
    if (noticeKind)
      views.set(delivery.messageId, {
        ...views.get(delivery.messageId),
        noticeKind,
        ...(taskDiscussion ? { taskDiscussion } : {}),
      });
    else if (taskDiscussion)
      views.set(delivery.messageId, { ...views.get(delivery.messageId), taskDiscussion });
  }
  return views;
}
