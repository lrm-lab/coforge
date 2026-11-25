import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { countDistinctMessages } from "./agent-history-read";
import { inboxNoticeText } from "./inbox-notice-text";
import { inboxPreviewLimit } from "./inbox-preview";
import { buildNoticeRows, renderNoticeRows } from "./inbox-preview-rows";
import { isTrackedMention } from "./mention-delivery-tracker";
import type { NoticeEligibility } from "./notice-eligibility";

export function planDeliveryNotice(input: {
  agentId: string;
  announced: readonly AgentMessageDelivery[];
  queued: readonly AgentMessageDelivery[];
  prefix: string;
  previewedInFull: (target: string, sequence: number) => boolean;
  eligibility: NoticeEligibility;
}) {
  const { agentId, eligibility } = input;
  const queued = [...input.queued];
  const previewKey = (target: string, sequence: number) => `${target} ${sequence}`;
  const previewed = new Set<string>();
  for (const delivery of [...input.announced, ...queued]) {
    const { target, sequence } = delivery;
    if (
      target &&
      eligibility(agentId, delivery).basis !== "independent_event" &&
      input.previewedInFull(target, sequence)
    ) {
      previewed.add(previewKey(target, sequence));
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
      previewedInFull: (target, sequence) => previewed.has(previewKey(target, sequence)),
    });
    const rows = renderNoticeRows(view.rows.filter((row) => row.newIds.size || row.heldIds.size));
    if (!rows.length) return undefined;
    const included = new Set(view.rows.flatMap((row) => [...row.newIds]));
    return {
      announced: announced.filter((delivery) => included.has(delivery.messageId)),
      shown: view.whole,
      rows,
      totalCount: countDistinctMessages([...announced, ...waiting]),
      notice: input.prefix + inboxNoticeText(rows),
      trackedIds: announced.filter(isTrackedMention).map((delivery) => delivery.deliveryId),
    };
  };
}
