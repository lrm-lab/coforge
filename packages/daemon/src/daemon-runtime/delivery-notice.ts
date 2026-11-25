import { isTaskConversationTarget, type AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { countDistinctMessages } from "./agent-history-read";
import { inboxNoticeText } from "./inbox-notice-text";
import { inboxPreviewLimit } from "./inbox-preview";
import { buildNoticeRows, renderNoticeRows, type NoticeRow } from "./inbox-preview-rows";
import { isTrackedMention } from "./mention-delivery-tracker";

/** What one notice says and what it claims, built from the deliveries it announces plus whatever
 * is already queued for the Agent. */
export type DeliveryNotice = Readonly<{
  /** The rows as rendered, and the full ones the model has now been shown. */
  view: ReturnType<typeof buildNoticeRows>;
  rows: ReturnType<typeof renderNoticeRows>;
  totalCount: number;
  /** The text to write, prefix included. */
  notice: string;
  /** Tracked mentions, which the session names back if the notice never reaches the model. */
  trackedIds: readonly string[];
  fallbackText?: () => string | undefined;
}>;

/**
 * Builds the one notice a delivery announces. Every number in it is a fact the daemon owns right
 * now — the messages announced plus those queued — never a total accumulated across earlier
 * notices, and the wording never says messages are unread: the daemon does not know the server's
 * read cursor, and a notice can race a `check` or `read` that already advanced it.
 */
export function composeDeliveryNotice(input: {
  message: AgentMessageDelivery;
  announced: readonly AgentMessageDelivery[];
  queued: readonly AgentMessageDelivery[];
  /** The Workspace's own prefix for these notices, when it has one. */
  prefix: string;
  previewedInFull: (target: string, sequence: number) => boolean;
  hasSeen?: (agentId: string, target: string, sequence: number, conversationId: string) => boolean;
}): DeliveryNotice {
  const { message, announced, queued } = input;
  const view = buildNoticeRows({
    announced,
    queued,
    agentId: message.agentId,
    previewLimit: inboxPreviewLimit(),
    previewedInFull: input.previewedInFull,
  });
  const rows = renderNoticeRows(view.rows);
  const notice = input.prefix + inboxNoticeText(rows);
  const fallbackText =
    input.hasSeen &&
    taskNoticeFallback(view.rows, announced, queued, input.hasSeen, input.prefix, notice);
  return {
    view,
    rows,
    totalCount: countDistinctMessages([...announced, ...queued]),
    notice,
    ...(fallbackText ? { fallbackText } : {}),
    trackedIds: announced.filter(isTrackedMention).map((delivery) => delivery.deliveryId),
  };
}

function taskNoticeFallback(
  rows: readonly NoticeRow[],
  announced: readonly AgentMessageDelivery[],
  queued: readonly AgentMessageDelivery[],
  hasSeen: NonNullable<Parameters<typeof composeDeliveryNotice>[0]["hasSeen"]>,
  prefix: string,
  originalText: string,
): (() => string | undefined) | undefined {
  if (!rows.some(({ target }) => isTaskConversationTarget(target))) return undefined;
  const tasks = new Map<
    string,
    { agentId: string; target: string; sequence: number; conversationId: string }
  >();
  for (const deliveries of [announced, queued]) {
    for (const {
      agentId,
      target,
      sequence,
      conversationId,
      messageId,
      source,
      mentionDelivery,
    } of deliveries) {
      if (target && isTaskConversationTarget(target) && source !== "app" && !mentionDelivery)
        tasks.set(messageId, { agentId, target, sequence, conversationId });
    }
  }
  if (!tasks.size) return undefined;

  const read = new Set<string>();
  return () => {
    for (const [id, { agentId, target, sequence, conversationId }] of tasks)
      if (hasSeen(agentId, target, sequence, conversationId)) read.add(id);
    if (!read.size) return originalText;

    const pending = rows.flatMap(({ target, newIds, heldIds, previews }) => {
      const newlyWaiting = new Set([...newIds].filter((id) => !read.has(id)));
      const stillHeld = new Set([...heldIds].filter((id) => !read.has(id)));
      if (!newlyWaiting.size && !stillHeld.size) return [];
      return [
        {
          target,
          newIds: newlyWaiting,
          heldIds: stillHeld,
          previews: previews.filter(({ messageId }) => !read.has(messageId)),
        },
      ];
    });
    return pending.length ? prefix + inboxNoticeText(renderNoticeRows(pending)) : undefined;
  };
}
