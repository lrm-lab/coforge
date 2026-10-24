import { expect, test } from "bun:test";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { AgentMessageOperations } from "#src/daemon-runtime/agent-message-operations";

const message = {
  id: "message-1",
  sequence: 1,
  senderKind: "human" as const,
  senderHandle: "ada",
  senderDescription: "",
  target: "@ada",
  body: "hi",
  createdAt: "2026-09-16T00:00:00.000Z",
  attachments: [],
};

function operations(messages: (typeof message)[], appItemsPending: () => Promise<number>) {
  return new AgentMessageOperations({
    connection: { workspaceId: "workspace", computerId: "computer" },
    attention: new AgentMessageAttentionIndex(
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
    ),
    isMemoryAgent: () => false,
    inbox: () => {
      throw new Error("not a send");
    },
    appItemsPending,
    transport: {
      agentMessage: async (request) => ({
        idempotencyKey: request.idempotencyKey,
        accepted: true,
        attentionCount: 0,
        messages,
        hasMore: false,
      }),
    },
    reportFreshnessHold: () => {},
  });
}

const check = (ops: AgentMessageOperations) =>
  ops.handle(
    "agent-a",
    { idempotencyKey: "check", context: "context", operation: "check" },
    undefined,
    "key",
  );

test("a check that found no message reports the App Inbox items waiting", async () => {
  expect(await check(operations([], async () => 3))).toMatchObject({ appItemsPending: 3 });
});

test("a check that found messages does not read the App Inbox", async () => {
  let reads = 0;
  const response = await check(
    operations([message], async () => {
      reads += 1;
      return 3;
    }),
  );
  expect(response.appItemsPending).toBeUndefined();
  expect(reads).toBe(0);
});
