import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import type { NoticeEligibility } from "./notice-eligibility";
import { planDeliveryNotice } from "./delivery-notice";
import type { ImportantUnreadNotice } from "./important-unread-notice";
import type {
  ImportantUnreadBatchDelivery,
  ImportantUnreadComposedNotice,
} from "./important-unread-reminder";

const logger = getLogger(["coforge", "daemon", "message-attention"]);

export type UnreadNoticeComposePorts = Readonly<{
  queued(agentId: string): readonly AgentMessageDelivery[];
  prefix(agentId: string): string;
  previewedInFull(agentId: string, target: string, sequence: number): boolean;
  eligibility: NoticeEligibility;
  captureAcceptance?(agentId: string): (messages: readonly AgentMessageDelivery[]) => boolean;
}>;

export function unreadNoticeComposer(ports: UnreadNoticeComposePorts) {
  return (
    agentId: string,
    _notice: ImportantUnreadNotice,
    deliveries: readonly ImportantUnreadBatchDelivery[],
  ): ImportantUnreadComposedNotice | undefined => {
    const original = deliveries.filter(
      (delivery): delivery is AgentMessageDelivery & { target: string } =>
        delivery.messageId !== undefined && delivery.target !== undefined,
    );
    if (!original.length) return undefined;
    const current = planDeliveryNotice({
      agentId,
      announced: original,
      queued: ports.queued(agentId),
      prefix: ports.prefix(agentId),
      eligibility: ports.eligibility,
      previewedInFull: (target, sequence) => ports.previewedInFull(agentId, target, sequence),
    });
    const record = ports.captureAcceptance?.(agentId);
    let selected = current();
    if (!selected) return undefined;
    const requestIds = original.map(({ requestId }) => requestId);
    const refresh = () => {
      selected = current();
      return selected?.notice;
    };
    return {
      text: selected.notice,
      requestIds,
      deliveries: selected.deliveries,
      fallbackText: () => {
        const text = refresh();
        logger.info("Reliable inbox notice fallback decided", {
          event: "agent.inbox_notice.submission_decision",
          agent_id: agentId,
          request_ids: requestIds,
          boundary: "fallback",
          outcome: text ? "submit" : "suppress",
        });
        return text;
      },
      prepareSubmission: refresh,
      get shown() {
        return selected?.shown;
      },
      ...(record ? { accepted: () => record(selected?.announced ?? []) } : {}),
    };
  };
}
