import { expect, test } from "bun:test";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { AgentMessageOperations } from "#src/daemon-runtime/agent-message-operations";

test("Memory cannot silently read a parent channel instead of its unread Task thread", async () => {
  const attention = new AgentMessageAttentionIndex(
    "workspace",
    {
      session: () => ({
        notify: async () => {},
        sendMessage: async () => {},
        subscribe: () => () => {},
        onExit: () => () => {},
        interrupt: async () => {},
        dispose: async () => {},
      }),
    },
    async () => {},
  );
  const thread = "#research:11111111-1111-4111-8111-111111111111";
  await attention.receive({
    protocolMajor: 1,
    requestId: "request",
    deliveryId: "delivery",
    messageId: "message",
    workspaceId: "workspace",
    conversationId: "channel",
    agentId: "memory",
    target: thread,
    sequence: 7,
    body: "The previous queries failed; try another method.",
    mentionsAgent: true,
    method: "agent:v1:message:deliver",
  });
  const operations = new AgentMessageOperations({
    connection: { workspaceId: "workspace", computerId: "computer" },
    attention,
    isMemoryAgent: (agentId) => agentId === "memory",
    inbox: () => {
      throw new Error("not a send");
    },
    transport: {
      agentMessage: async (request) => ({
        protocolMajor: 1,
        idempotencyKey: request.idempotencyKey,
        accepted: true,
        attentionCount: 0,
        messages:
          request.target === thread
            ? [
                {
                  id: "message",
                  sequence: 7,
                  senderKind: "agent",
                  senderHandle: "task",
                  senderDescription: "",
                  target: thread,
                  body: "The previous queries failed; try another method.",
                  createdAt: new Date().toISOString(),
                  attachments: [],
                },
              ]
            : [],
        modelSeenUpToSeq: request.target === thread ? 7 : null,
      }),
    },
    reportFreshnessHold: () => {},
  });
  const read = (target: string) =>
    operations.handle(
      "memory",
      {
        idempotencyKey: crypto.randomUUID(),
        context: "context",
        operation: "read",
        target,
      },
      target,
      "key",
    );
  expect((await read("#elsewhere")).accepted).toBe(true);
  expect(
    (
      await operations.handle(
        "task",
        { idempotencyKey: "task-read", context: "context", operation: "read", target: "#research" },
        "#research",
        "key",
      )
    ).accepted,
  ).toBe(true);
  expect(
    (
      await operations.handle(
        "memory",
        {
          idempotencyKey: "history",
          context: "context",
          operation: "read",
          target: "#research",
          around: "root",
        },
        "#research",
        "key",
      )
    ).accepted,
  ).toBe(true);
  await expect(read("#research")).rejects.toThrow(thread);
  expect(attention.check("memory").map((item) => item.target)).toEqual([thread]);
  expect((await read(thread)).messages.map((message) => message.body)).toEqual([
    "The previous queries failed; try another method.",
  ]);
  expect(attention.check("memory")).toHaveLength(0);
  expect((await read("#research")).accepted).toBe(true);
});

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
