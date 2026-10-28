import { expect, test } from "bun:test";
import type { AgentMessageDelivery, TaskView } from "@lrm/coforge-sdk/internal";
import type { AgentNoticeOptions, AgentSession } from "@coforge/agent";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { AgentTaskOperations } from "#src/daemon-runtime/agent-task-operations";

test("a held batch separates task threads in the same channel", async () => {
  const notices: { text: string; options?: AgentNoticeOptions }[] = [];
  const session: AgentSession = {
    async sendMessage() {},
    async handoffTask() {},
    async notify(text, options) {
      notices.push({ text, options });
    },
    subscribe() {
      return () => {};
    },
    onExit() {
      return () => {};
    },
    async interrupt() {},
    async dispose() {},
  };
  const index = new AgentMessageAttentionIndex(
    "workspace",
    { session: () => session },
    async () => {},
  );
  const delivery = (root: string, sequence: number): AgentMessageDelivery => ({
    protocolMajor: 1,
    requestId: root,
    deliveryId: root,
    messageId: root,
    workspaceId: "workspace",
    agentId: "agent",
    conversationId: "channel",
    body: "Message",
    method: "agent:v1:message:deliver",
    target: `#project:${root}`,
    sequence,
  });
  await index.flush("agent", [
    delivery("11111111-1111-4111-8111-111111111111", 1),
    delivery("77777777-7777-4777-8777-777777777777", 7),
  ]);
  await index.recover(
    "agent",
    [
      {
        messageId: "recovered-result-1",
        conversationId: "channel",
        target: "#project:11111111-1111-4111-8111-111111111111",
        sequence: 10,
        deliveryId: "recovery-1",
        latestSenderKind: "human",
        latestSenderHandle: "user",
        latestSenderDescription: "User",
        body: "First result",
      },
      {
        messageId: "recovered-result-7",
        conversationId: "channel",
        target: "#project:77777777-7777-4777-8777-777777777777",
        sequence: 11,
        deliveryId: "recovery-7",
        latestSenderKind: "human",
        latestSenderHandle: "user",
        latestSenderDescription: "User",
        body: "Other result",
      },
    ],
    {},
  );
  expect(notices).toHaveLength(4);
  expect(notices[2]!.options?.conversation?.target).toBe(
    "#project:11111111-1111-4111-8111-111111111111",
  );
  expect(notices[2]!.text).not.toContain("77777777-7777-4777-8777-777777777777");
  expect(notices[3]!.options?.conversation?.target).toBe(
    "#project:77777777-7777-4777-8777-777777777777",
  );

  expect(notices[0]!.options?.conversation?.target).toBe(
    "#project:11111111-1111-4111-8111-111111111111",
  );
  expect(notices[0]!.text).not.toContain("77777777-7777-4777-8777-777777777777");
  expect(notices[1]!.options?.conversation?.target).toBe(
    "#project:77777777-7777-4777-8777-777777777777",
  );
});

test("an authorized new claim hands its actual task to the runtime and preserves the result", async () => {
  const handoffs: unknown[] = [];
  const requests: unknown[] = [];
  const task: TaskView = {
    messageId: "root",
    conversationId: "channel",
    number: 7,
    title: "Diagnose",
    description: "Evidence",
    status: "in_progress",
    revision: 2,
    owner: { memberId: "member", kind: "agent", id: "agent", name: "Worker", handle: "worker" },
    creator: { memberId: "creator", kind: "user", id: "user", name: "User", handle: "user" },
    createdAt: "2026-10-28T00:00:00Z",
    updatedAt: "2026-10-28T00:00:00Z",
    execution: { id: "execution", attempt: 1 },
  };
  const session: AgentSession = {
    async sendMessage() {},
    async handoffTask(value) {
      handoffs.push(value);
    },
    subscribe() {
      return () => {};
    },
    onExit() {
      return () => {};
    },
    async interrupt() {},
    async dispose() {},
  };
  const attention = new AgentMessageAttentionIndex(
    "workspace",
    { session: () => session },
    async () => {},
  );
  const operations = new AgentTaskOperations({
    stateDirectory: "/unused",
    workspaceId: "workspace",
    attention,
    session: () => session,
    apiKey: () => "unused",
    async acknowledge() {},
    authorizedAgent(context) {
      if (context !== "authorized") throw new Error("unauthorized");
      return "agent";
    },
    transport: {
      async agentTask(request) {
        requests.push(request);
        return {
          tasks: [task],
          claims: [{ number: 7, success: true }],
          idempotencyKey: request.idempotencyKey,
        };
      },
    },
  });
  const result = await operations.handle(
    "authorized",
    { operation: "claim", idempotencyKey: "key", target: "#project", number: 7 },
    "unused",
  );
  expect(requests).toEqual([
    {
      operation: "claim",
      idempotencyKey: "key",
      target: "#project",
      number: 7,
      isolatedExecution: true,
    },
  ]);
  expect(handoffs).toEqual(result.executionHandoffs!);
  expect(result.executionHandoffs![0]!.target).toBe("#project:root");
  expect(result.tasks).toEqual([task]);
  await expect(
    operations.handle(
      "unauthorized",
      { operation: "claim", idempotencyKey: "key", target: "#project", number: 7 },
      "unused",
    ),
  ).rejects.toThrow("unauthorized");
  expect(requests).toHaveLength(1);
});
