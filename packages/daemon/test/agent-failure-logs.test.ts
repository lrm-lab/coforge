import { expect, test } from "bun:test";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { logAgentOperationFailure } from "#src/daemon-runtime/agent-failure-logs";
import { captureDaemonLogs } from "./log-capture";

const delivery = {
  protocolMajor: 1,
  requestId: "request-1",
  messageId: "message-1",
  deliveryId: "delivery-1",
  sequence: 1,
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  agentId: "agent-1",
  body: "body",
  method: "agent:v1:message:deliver",
} satisfies AgentMessageDelivery;

test("a delivery failure logs the scrubbed message and not the stack", async () => {
  const error = new Error("invalid agent message scope token=sk-abcdef123456");
  const { records } = await captureDaemonLogs(async () => {
    logAgentOperationFailure("computer-1", "message_delivery", delivery, error);
  });
  const failure = records.find(
    (record) => record.properties.event === "agent_runtime:message_delivery_failed",
  );
  expect(failure?.properties).toMatchObject({
    request_id: "request-1",
    agent_id: "agent-1",
    error_code: "Error",
    error_message: "invalid agent message scope token=[REDACTED]",
    outcome: "failed",
  });
  expect(failure?.properties).not.toHaveProperty("stack");
  expect(JSON.stringify(failure?.properties)).not.toContain("sk-abcdef123456");
  expect(JSON.stringify(failure?.properties)).not.toContain("agent-failure-logs");
});

test("a logged failure message is capped", async () => {
  const { records } = await captureDaemonLogs(async () => {
    logAgentOperationFailure(
      "computer-1",
      "message_delivery",
      delivery,
      new Error("x".repeat(600)),
    );
  });
  const failure = records.find(
    (record) => record.properties.event === "agent_runtime:message_delivery_failed",
  );
  expect(failure?.properties.error_message).toBe("x".repeat(512));
});
