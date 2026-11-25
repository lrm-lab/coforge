import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { isCardEvent, type ConsumedReadBasis } from "./agent-message-attention-index-helpers";

export type NoticeCandidate = Pick<
  AgentMessageDelivery,
  "target" | "conversationId" | "sequence" | "reason" | "source"
> & { through?: true; mentionDelivery?: unknown };

export type NoticeEligibility = (
  agentId: string,
  candidate: NoticeCandidate,
) =>
  | { disposition: "notify"; basis: "unread" | "independent_event" | "unscoped" }
  | { disposition: "settle"; basis: ConsumedReadBasis };

export function noticeEligibility(
  readBasis: (
    agentId: string,
    target: string,
    sequence: number,
    conversationId: string,
  ) => ConsumedReadBasis | undefined,
): NoticeEligibility {
  return (agentId, candidate) => {
    if (isCardEvent(candidate) || candidate.source === "app" || candidate.mentionDelivery) {
      return { disposition: "notify", basis: "independent_event" };
    }
    const { target, sequence, conversationId } = candidate;
    if (!target || !conversationId) return { disposition: "notify", basis: "unscoped" };
    const basis = readBasis(agentId, target, sequence, conversationId);
    if (basis && (!candidate.through || basis === "read_frontier")) {
      return { disposition: "settle", basis };
    }
    return { disposition: "notify", basis: "unread" };
  };
}
