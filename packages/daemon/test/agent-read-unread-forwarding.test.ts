import { expect, test } from "bun:test";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { AgentMessageOperations } from "#src/daemon-runtime/agent-message-operations";
function operations(
  sent: {
    unread?: boolean;
  }[],
) {
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
    inbox: () => {
      throw new Error("not a send");
    },
    transport: {
      agentMessage: async (request) => {
        sent.push(request);
        return {
          idempotencyKey: request.idempotencyKey,
          accepted: true,
          attentionCount: 0,
          messages: [],
          hasMore: false,
        };
      },
    },
    reportFreshnessHold: () => {},
  });
}
const read = (
  ops: AgentMessageOperations,
  agentId: string,
  extra: {
    unread?: boolean;
    around?: string;
  } = {},
) =>
  ops.handle(
    agentId,
    {
      idempotencyKey: crypto.randomUUID(),
      context: "context",
      operation: "read",
      target: "#a",
      ...extra,
    },
    "#a",
    "key",
  );
test("an unanchored read requests unread only when explicitly selected", async () => {
  const sent: {
    unread?: boolean;
  }[] = [];
  const ops = operations(sent);
  await read(ops, "agent-a");
  await read(ops, "task");
  await read(ops, "task", { unread: true });
  expect(sent.map((request) => request.unread)).toEqual([undefined, undefined, true]);
});
test("an anchored read stays a history read", async () => {
  const sent: {
    unread?: boolean;
  }[] = [];
  await read(operations(sent), "agent-a", { around: "message" });
  expect(sent.map((request) => request.unread)).toEqual([undefined]);
});
