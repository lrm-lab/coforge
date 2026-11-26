import type { AgentHistoryConsumptionScope } from "@lrm/coforge-sdk/agent";
import { threadRootTarget } from "@lrm/coforge-sdk/internal";

/** A message as the Agent message API returns it, with a numbered body. */
export function messageRecord(
  sequence: number,
  sender: string,
  target: string,
  id = `message-${sequence}`,
) {
  return {
    id,
    sequence,
    senderKind: "human" as const,
    senderHandle: sender.replace(/^@/, ""),
    senderDescription: "",
    target,
    body: `body-${sequence}`,
    createdAt: "2026-09-03T00:00:00Z",
    attachments: [],
  };
}

export function readScope(agentId: string, target: string): AgentHistoryConsumptionScope {
  return {
    agentId,
    target,
    conversationId: "conversation-a",
    channelType: threadRootTarget(target) ? "thread" : "dm",
  };
}

export function scopedCheckMessage(
  sequence: number,
  sender: string,
  target: string,
  id?: string,
  conversationId = "conversation-a",
) {
  return {
    ...messageRecord(sequence, sender, target, id),
    consumptionScope: { conversationId },
  };
}
