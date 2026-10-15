import { expect, test } from "bun:test";
import {
  encodeAgentMessageDelivery,
  decodeAgentMessageDelivery,
  encodeAgentStartIntent,
  decodeAgentStartIntent,
} from "./codec";
import { encodeAgentMessageResponse, decodeAgentMessageResponse } from "./local-daemon";
import { AGENT_MESSAGE_METHOD, AGENT_START_MESSAGE_TYPE, WORKSPACE_PROTOCOL_MAJOR } from "./index";

const memoryHint = { hint_id: "server-hint", tool: "memory_disposition" as const };
test("target receipt metadata survives delivery, restart recovery, and local message reads", () => {
  const delivery = {
    protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
    method: AGENT_MESSAGE_METHOD,
    requestId: "request",
    workspaceId: "workspace",
    conversationId: "conversation",
    agentId: "agent",
    messageId: "message",
    deliveryId: "delivery",
    sequence: 1,
    body: "@task check these constraints",
    target: "#channel",
    latestSenderKind: "agent" as const,
    latestSenderHandle: "memory",
    memoryHint,
  };
  expect(decodeAgentMessageDelivery(encodeAgentMessageDelivery(delivery)).memoryHint).toEqual(
    memoryHint,
  );
  const start = {
    protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
    messageType: AGENT_START_MESSAGE_TYPE,
    requestId: "start",
    workspaceId: "workspace",
    computerId: "computer",
    agentId: "agent",
    provider: "pi" as const,
    model: "test-model",
    reasoning: "off",
    resumeMessages: [{ ...delivery, latestSenderDescription: "Memory Agent" }],
  };
  expect(
    decodeAgentStartIntent(encodeAgentStartIntent(start)).resumeMessages?.[0]?.memoryHint,
  ).toEqual(memoryHint);
  const response = {
    idempotencyKey: "read",
    accepted: true,
    attentionCount: 0,
    messageId: "",
    summaries: [],
    messages: [
      {
        id: "message",
        sequence: 1,
        senderKind: "agent" as const,
        senderHandle: "memory",
        senderDescription: "Memory Agent",
        target: "#channel",
        body: delivery.body,
        createdAt: "2026-10-15T04:00:00Z",
        attachments: [],
        memoryHint,
      },
    ],
  };
  expect(
    decodeAgentMessageResponse(encodeAgentMessageResponse(response)).messages[0]?.memoryHint,
  ).toEqual(memoryHint);
});
