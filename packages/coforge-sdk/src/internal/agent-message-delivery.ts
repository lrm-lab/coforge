import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { AgentMessageDeliverySchema } from "#src/internal/gen/coforge/rpc/v1/workspace_pb";
import { safeUint64 } from "./agent-observation-codec";
import { assertUint } from "./codec";
import { AGENT_MESSAGE_METHOD } from "./index";
import { mentionDeliveryEnvelopeMessage, readMentionDeliveryEnvelope } from "./mention-delivery";
import { assertValidMessageSender, isValidMessageSender } from "./message-sender";
export type AgentMessageDelivery = {
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
  mentionsAgent?: boolean;
  nonMemberMention?: boolean;
  taskExecutionSessionId?: string;
  mentionDelivery?: import("./mention-delivery").MentionDeliveryEnvelope;
  createdAtMs?: number;
  features?: {
    taskConversations?: boolean;
    artifacts?: boolean;
    agentContextView?: boolean;
  };
  reason?: string;
  attachmentCount?: number;
  source?: "app";
};
export function encodeAgentMessageDelivery(value: AgentMessageDelivery): Uint8Array {
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
  if (value.attachmentCount !== undefined)
    assertUint(value.attachmentCount, 0xffffffff, "Agent message attachment count");
  if (value.source !== undefined && value.source !== "app")
    throw new Error("agent message delivery source must be app");
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
      createdAtMs: value.createdAtMs === undefined ? undefined : BigInt(value.createdAtMs),
      taskConversations: value.features?.taskConversations,
      artifacts: value.features?.artifacts,
      agentContextView: value.features?.agentContextView,
      reason: value.reason,
      attachmentCount: value.attachmentCount,
      source: value.source,
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
    ...(value.createdAtMs !== undefined
      ? { createdAtMs: safeUint64(value.createdAtMs, "Agent message creation time") }
      : {}),
    ...(value.taskConversations !== undefined ||
    value.artifacts !== undefined ||
    value.agentContextView !== undefined
      ? {
          features: {
            ...(value.taskConversations !== undefined
              ? { taskConversations: value.taskConversations }
              : {}),
            ...(value.artifacts !== undefined ? { artifacts: value.artifacts } : {}),
            ...(value.agentContextView !== undefined
              ? { agentContextView: value.agentContextView }
              : {}),
          },
        }
      : {}),
    ...(value.reason ? { reason: value.reason } : {}),
    ...(value.attachmentCount !== undefined ? { attachmentCount: value.attachmentCount } : {}),
    ...(value.source === "app" ? { source: "app" as const } : {}),
  };
}
