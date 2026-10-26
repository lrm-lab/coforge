import type { OPENVIKING_AGENT_PROTOCOL, OpenVikingAgentErrorCode } from "./openviking-memory";
import type { OpenVikingCitation } from "./memory-citations";

/** Message commit outcome, independent of a later HTTP/application error. */
export type MemoryOfferPublication =
  | { phase: "rejected_before_publish" }
  | { phase: "published"; messageId: string };

/** Malformed or absent metadata is unknown and must never refund a slot. */
export function decodeMemoryOfferPublication(value: unknown): MemoryOfferPublication | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as { phase?: unknown; messageId?: unknown };
  if (record.phase === "rejected_before_publish" && record.messageId === undefined)
    return { phase: "rejected_before_publish" };
  if (
    record.phase === "published" &&
    typeof record.messageId === "string" &&
    record.messageId.trim()
  )
    return { phase: "published", messageId: record.messageId };
  return undefined;
}

export type OpenVikingOfferResponse = {
  protocol: typeof OPENVIKING_AGENT_PROTOCOL;
  op: "offer";
  operationId: string;
  publication?: MemoryOfferPublication;
  published: boolean;
  duplicate: boolean;
  messageId?: string;
  recipientAgentId?: string;
  citations: OpenVikingCitation[];
};

export type OpenVikingAgentError = {
  publication?: MemoryOfferPublication;
  protocol: typeof OPENVIKING_AGENT_PROTOCOL;
  operationId?: string;
  error: {
    code: OpenVikingAgentErrorCode;
    message: string;
  };
};
