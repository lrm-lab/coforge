import { expect, test } from "bun:test";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";

const delivery = (id: string): AgentMessageDelivery => ({
  protocolMajor: 1,
  requestId: `request-${id}`,
  messageId: `message-${id}`,
  deliveryId: `delivery-${id}`,
  sequence: 1,
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  agentId: "agent-1",
  body: "private body",
  method: "agent:v1:message:deliver",
  target: "@agent",
});

const session = () => ({
  sendMessage: async () => {},
  notify: async () => {},
  subscribe: () => () => {},
  interrupt: async () => {},
  onExit: () => () => {},
  dispose: async () => {},
});

test("journals every attention decision when a decision port is composed", async () => {
  const written: Array<{ messageId: string; outcome: string }> = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session() },
    async () => {},
    () => {},
    {
      shouldHold: () => false,
      enqueue: () => {},
      busy: () => {},
      attentionDecisions: {
        append: (row) => written.push(row),
        read: () => [],
      },
    },
  );
  await index.receive(delivery("journal"));
  expect(written.length).toBeGreaterThan(0);
  expect(written[0]!.messageId).toBe("message-journal");
});
