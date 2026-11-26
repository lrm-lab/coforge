import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { countDistinctMessages } from "./agent-history-read";
import { inboxNoticeText } from "./inbox-notice-text";
import { inboxPreviewLimit } from "./inbox-preview";
import { buildNoticeRows, renderNoticeRows, type NoticeRowItem } from "./inbox-preview-rows";
import { isTrackedMention } from "./mention-delivery-tracker";
import type { NoticeEligibility } from "./notice-eligibility";

export function planDeliveryNotice(input: {
  agentId: string;
  announced: readonly AgentMessageDelivery[];
  queued: readonly AgentMessageDelivery[];
  prefix: string;
  previewedInFull: (target: string, sequence: number, conversationId: string) => boolean;
  eligibility: NoticeEligibility;
}) {
  const { agentId, eligibility } = input;
  const queued = [...input.queued];
  const previewed = new Set<NoticeRowItem>();
  for (const delivery of [...input.announced, ...queued]) {
    const { target, sequence, conversationId } = delivery;
    if (
      target &&
      eligibility(agentId, delivery).basis !== "independent_event" &&
      input.previewedInFull(target, sequence, conversationId)
    ) {
      previewed.add(delivery);
    }
  }

  return () => {
    const eligible = (delivery: AgentMessageDelivery) =>
      eligibility(agentId, delivery).disposition === "notify";
    const announced = input.announced.filter(eligible);
    const waiting = queued.filter(eligible);
    const view = buildNoticeRows({
      announced,
      queued: waiting,
      agentId,
      previewLimit: inboxPreviewLimit(),
      previewedInFull: (delivery) => previewed.has(delivery),
    });
    const rows = renderNoticeRows(view.rows.filter((row) => row.newIds.size || row.heldIds.size));
    if (!rows.length) return undefined;
    const included = new Set(view.rows.flatMap((row) => [...row.newIds]));
    const held = new Set(view.rows.flatMap((row) => [...row.heldIds]));
    const displayed = announced.filter((delivery) => included.has(delivery.messageId));
    return {
      announced: displayed,
      deliveries: [...displayed, ...waiting.filter((delivery) => held.has(delivery.messageId))].map(
        ({ target, conversationId, sequence, deliveryId }) => ({
          target,
          conversationId,
          sequence,
          deliveryId,
        }),
      ),
      shown: view.whole,
      rows,
      totalCount: countDistinctMessages([...announced, ...waiting]),
      notice: input.prefix + inboxNoticeText(rows),
      trackedIds: announced.filter(isTrackedMention).map((delivery) => delivery.deliveryId),
    };
  };
}
