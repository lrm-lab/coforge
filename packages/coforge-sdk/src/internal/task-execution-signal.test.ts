import { expect, test } from "bun:test";
import { encodeAgentMessageDelivery, decodeAgentMessageDelivery } from "./agent-message-delivery";

test("task execution signals round-trip and reject malformed fences", () => {
  const delivery = {
    protocolMajor: 1,
    requestId: "request",
    messageId: "message",
    deliveryId: "delivery",
    workspaceId: "workspace",
    conversationId: "conversation",
    agentId: "agent",
    body: "Task closed",
    sequence: 1,
    method: "agent:v1:message:deliver" as const,
    latestSenderKind: "system" as const,
    taskExecutionSignal: { executionSessionId: "execution", attempt: 2, kind: "ended" as const },
  };
  expect(
    decodeAgentMessageDelivery(encodeAgentMessageDelivery(delivery)).taskExecutionSignal,
  ).toEqual(delivery.taskExecutionSignal);
  expect(() =>
    encodeAgentMessageDelivery({
      ...delivery,
      taskExecutionSignal: { ...delivery.taskExecutionSignal, attempt: 0 },
    }),
  ).toThrow("task execution signal");
});
