import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { AgentMessageDeliverySchema } from "#src/internal/gen/coforge/rpc/v1/workspace_pb";
import { safeUint64 } from "./agent-observation-codec";
import { assertUint } from "./codec";
import { AGENT_MESSAGE_METHOD } from "./index";
import { memoryHintMessage, readMemoryHint } from "./memory-hint";
import { mentionDeliveryEnvelopeMessage, readMentionDeliveryEnvelope } from "./mention-delivery";
import { assertValidMessageSender, isValidMessageSender } from "./message-sender";

/** One message the server delivers to an Agent's daemon (`AgentMessageDelivery`). */
export type AgentMessageDelivery = {
  memoryHint?: import("#src/agent/memory-disposition").MemoryHintDelivery;
  protocolMajor: number;
  requestId: string;
  messageId: string;
  deliveryId: string;
  sequence: number;
  workspaceId: string;
  conversationId: string;
  agentId: string;
  body: string;
  method: typeof AGENT_MESSAGE_METHOD;
  target?: string;
  latestSenderKind?: import("./message-sender").MessageSenderKind;
  latestSenderHandle?: string;
  latestSenderDescription?: string;
  /** True when this delivery personally @mentioned the recipient Agent. */
  mentionsAgent?: boolean;
  /** True when the recipient Agent was notified of this message without being a channel member. */
  nonMemberMention?: boolean;
  /** Present when this delivery starts an isolated Task execution session. */
  taskExecutionSessionId?: string;
  /** Present on a tracked @mention delivery; an ACK echoes it once the mention is drained. */
  mentionDelivery?: import("./mention-delivery").MentionDeliveryEnvelope;
  /** When the server created the message, in epoch milliseconds: not when the daemon received
   * it, which differs for a message replayed after a reconnect. Absent from an older server. */
  createdAtMs?: number;
  /** The Workspace's features as of this delivery; absent from an older server. A session
   * launched with another value restarts before it takes the input. */
  features?: { taskConversations: boolean };
  /** Why this delivery reached the Agent on a target it was not subscribed to: "mentioned" or
   * "subscribed". Absent on ordinary channel, DM and non-member-mention deliveries and from an
   * older server. */
  reason?: string;
};

export function encodeAgentMessageDelivery(value: AgentMessageDelivery): Uint8Array {
  // Protobuf omits an empty string, and the daemon rejects a delivery with no request_id.
  if (!value.requestId?.trim()) throw new Error("agent message delivery requires requestId");
  assertUint(value.sequence, Number.MAX_SAFE_INTEGER, "Agent message sequence");
  if (value.createdAtMs !== undefined)
    assertUint(value.createdAtMs, Number.MAX_SAFE_INTEGER, "Agent message creation time");
  if (value.latestSenderKind !== undefined)
    assertValidMessageSender(
      value.latestSenderKind,
      value.latestSenderHandle ?? "",
      "Agent message delivery",
    );
  return toBinary(
    AgentMessageDeliverySchema,
    create(AgentMessageDeliverySchema, {
      protocolMajor: value.protocolMajor,
      requestId: value.requestId,
      messageId: value.messageId,
      deliveryId: value.deliveryId,
      sequence: BigInt(value.sequence),
      workspaceId: value.workspaceId,
      conversationId: value.conversationId,
      agentId: value.agentId,
      body: value.body,
      method: value.method,
      target: value.target ?? "",
      latestSenderKind: value.latestSenderKind ?? "",
      latestSenderHandle: value.latestSenderHandle ?? "",
      latestSenderDescription: value.latestSenderDescription ?? "",
      mentionsAgent: value.mentionsAgent,
      nonMemberMention: value.nonMemberMention,
      taskExecutionSessionId: value.taskExecutionSessionId ?? "",
      mentionDelivery: mentionDeliveryEnvelopeMessage(value.mentionDelivery),
      memoryHint: memoryHintMessage(value.memoryHint),
      createdAtMs: value.createdAtMs === undefined ? undefined : BigInt(value.createdAtMs),
      taskConversations: value.features?.taskConversations,
      reason: value.reason,
    }),
  );
}
export function decodeAgentMessageDelivery(bytes: Uint8Array): AgentMessageDelivery {
  const value = fromBinary(AgentMessageDeliverySchema, bytes);
  if (
    value.method !== AGENT_MESSAGE_METHOD ||
    !value.requestId ||
    !value.messageId ||
    !value.workspaceId ||
    !value.conversationId ||
    !value.agentId ||
    !value.body ||
    (value.latestSenderKind &&
      !isValidMessageSender(value.latestSenderKind, value.latestSenderHandle))
  )
    throw new Error("invalid agent message delivery");
  const mentionDelivery = readMentionDeliveryEnvelope(value.mentionDelivery);
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    messageId: value.messageId,
    deliveryId: value.deliveryId,
    sequence: safeUint64(value.sequence, "Agent message sequence"),
    workspaceId: value.workspaceId,
    conversationId: value.conversationId,
    agentId: value.agentId,
    body: value.body,
    method: AGENT_MESSAGE_METHOD,
    ...(value.target ? { target: value.target } : {}),
    ...(value.latestSenderKind
      ? {
          latestSenderKind: value.latestSenderKind as AgentMessageDelivery["latestSenderKind"],
          latestSenderHandle: value.latestSenderHandle,
          latestSenderDescription: value.latestSenderDescription,
        }
      : {}),
    ...(value.mentionsAgent !== undefined ? { mentionsAgent: value.mentionsAgent } : {}),
    ...(value.nonMemberMention ? { nonMemberMention: true } : {}),
    ...(value.taskExecutionSessionId
      ? { taskExecutionSessionId: value.taskExecutionSessionId }
      : {}),
    ...(mentionDelivery ? { mentionDelivery } : {}),
    ...(value.memoryHint ? { memoryHint: readMemoryHint(value.memoryHint) } : {}),
    ...(value.createdAtMs !== undefined
      ? { createdAtMs: safeUint64(value.createdAtMs, "Agent message creation time") }
      : {}),
    ...(value.taskConversations !== undefined
      ? { features: { taskConversations: value.taskConversations } }
      : {}),
    ...(value.reason ? { reason: value.reason } : {}),
  };
}
