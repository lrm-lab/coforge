import { expect, test } from "bun:test";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { AgentMessageOperations } from "#src/daemon-runtime/agent-message-operations";

test("targeted message checks return only their group's attention, with matching counts", async () => {
  const native = {
    sendMessage: async () => {},
    notify: async () => {},
    subscribe: () => () => {},
    onExit: () => () => {},
    interrupt: async () => {},
    dispose: async () => {},
  };
  const attention = new AgentMessageAttentionIndex(
    "workspace",
    { session: () => native },
    async () => {},
  );
  for (const group of ["alpha", "beta"])
    await attention.receive({
      protocolMajor: 1,
      requestId: group,
      deliveryId: group,
      messageId: group,
      workspaceId: "workspace",
      conversationId: group,
      agentId: "memory",
      target: `#${group}`,
      sequence: 1,
      body: "question",
      method: "agent:v1:message:deliver",
    });
  const operations = new AgentMessageOperations({
    connection: { workspaceId: "workspace", computerId: "computer" },
    attention,
    inbox: () => {
      throw new Error("not a send");
    },
    transport: {
      agentMessage: async (request) => ({
        protocolMajor: 1,
        idempotencyKey: request.idempotencyKey,
        accepted: true,
        attentionCount: 0,
        messages: [],
      }),
    },
    reportFreshnessHold: () => {},
  });
  const scoped = await operations.handle(
    "memory",
    { idempotencyKey: "check-alpha", context: "context", operation: "check", target: "#alpha" },
    "#alpha",
    "key",
  );
  expect(scoped.summaries?.map((summary) => summary.target)).toEqual(["#alpha"]);
  expect(scoped.attentionCount).toBe(1);
  const all = await operations.handle(
    "memory",
    { idempotencyKey: "check-all", context: "context", operation: "check" },
    undefined,
    "key",
  );
  expect(all.attentionCount).toBe(2);
});
