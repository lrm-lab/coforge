import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import type { NoticeEligibility } from "./notice-eligibility";
import { composeDeliveryNotice } from "./delivery-notice";
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
    const queued = [...ports.queued(agentId)];
    const prefix = ports.prefix(agentId);
    const previewed = new Set(
      [...original, ...queued]
        .filter(
          ({ target, sequence }) => target && ports.previewedInFull(agentId, target, sequence),
        )
        .map(({ target, sequence }) => `${target} ${sequence}`),
    );
    const record = ports.captureAcceptance?.(agentId);
    const current = () => {
      const eligible = (delivery: AgentMessageDelivery) =>
        ports.eligibility(agentId, delivery).disposition === "notify";
      const announced = original.filter(eligible);
      const waiting = queued.filter(eligible);
      const message = announced[0] ?? waiting.find(({ target }) => target);
      if (!message) return undefined;
      const { view, notice } = composeDeliveryNotice({
        message,
        announced,
        queued: waiting,
        prefix,
        previewedInFull: (target, sequence) => previewed.has(`${target} ${sequence}`),
      });
      const included = new Set(view.rows.flatMap((row) => [...row.newIds]));
      const accepted = announced.filter((item) => included.has(item.messageId));
      const text = view.rows.some(
        (row) => row.newIds.size || row.heldIds.size || row.previews.length,
      )
        ? notice
        : undefined;
      return { text, accepted, shown: view.whole };
    };

    let selected = current();
    if (!selected?.text) return undefined;
    const requestIds = original.map(({ requestId }) => requestId);
    const refresh = () => {
      selected = current();
      return selected?.text;
    };
    return {
      text: selected.text,
      requestIds,
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
      ...(record ? { accepted: () => record(selected?.accepted ?? []) } : {}),
    };
  };
}
