import { expect, test } from "bun:test";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { AgentMessageOperations } from "#src/daemon-runtime/agent-message-operations";

/** A read without an anchor shows the newest page; only `unread` reads from the read position.
 * A Memory Agent's `message_read` tool has no such argument and its increment read is the unread
 * read, so the daemon sets it. */

function operations(sent: { unread?: boolean }[]) {
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
    isMemoryAgent: (agentId) => agentId === "memory",
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
  extra: { unread?: boolean; around?: string } = {},
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

test("a Memory Agent's read without an anchor is the unread read; anyone else's is not", async () => {
  const sent: { unread?: boolean }[] = [];
  const ops = operations(sent);
  await read(ops, "memory");
  await read(ops, "task");
  await read(ops, "task", { unread: true });
  expect(sent.map((request) => request.unread)).toEqual([true, undefined, true]);
});

test("a Memory Agent's anchored read stays a history read", async () => {
  const sent: { unread?: boolean }[] = [];
  await read(operations(sent), "memory", { around: "message" });
  expect(sent.map((request) => request.unread)).toEqual([undefined]);
});
