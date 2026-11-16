import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { countDistinctMessages } from "./agent-history-read";
import { inboxNoticeText } from "./inbox-notice-text";
import { inboxPreviewLimit } from "./inbox-preview";
import { buildNoticeRows, renderNoticeRows } from "./inbox-preview-rows";
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
  return {
    view,
    rows,
    totalCount: countDistinctMessages([...announced, ...queued]),
    notice: input.prefix + inboxNoticeText(rows),
    trackedIds: announced.filter(isTrackedMention).map((delivery) => delivery.deliveryId),
  };
}
