import { expect, test } from "bun:test";
import type { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import type { AgentMessageTransportResponse } from "#src/connection/agent-message-adapters";
import type { TaskCommand } from "@lrm/coforge-sdk/internal";
import { taskWriteWithFreshness } from "#src/daemon-runtime/task-write-freshness";

function deps(calls: TaskCommand[]) {
  return {
    messageAttention: {
      check: () => [],
      modelSeenSequence: () => 0,
      seenExactSequences: () => [],
      hasExactSeen: () => false,
      hasSeen: () => false,
      recordModelSeen: () => {},
    } as unknown as AgentMessageAttentionIndex,
    agentMessage: async () =>
      ({
        idempotencyKey: "read",
        accepted: true,
        attentionCount: 0,
        messageId: "",
        summaries: [],
        messages: [
          {
            id: "m9",
            sequence: 9,
            senderKind: "human",
            senderHandle: "ada",
            senderDescription: "",
            target: "#c",
            body: "unread context",
            createdAt: "now",
            attachments: [],
          },
        ],
      }) as AgentMessageTransportResponse,
    workspaceId: "workspace-1",
    agentTask: async (command: TaskCommand) => {
      calls.push(command);
      return { idempotencyKey: command.idempotencyKey, tasks: [] };
    },
  };
}

const command = (overrides: Partial<TaskCommand> = {}): TaskCommand =>
  ({ idempotencyKey: "request", operation: "create", target: "#c", ...overrides }) as TaskCommand;

test("a create with unread context is held and the write never runs", async () => {
  const calls: TaskCommand[] = [];
  const result = await taskWriteWithFreshness(deps(calls), "agent-1", command(), "#c", "key");
  expect(result).toMatchObject({ state: "held" });
  expect(calls).toEqual([]);
});

test("a create with continueAnyway skips the hold and runs the write", async () => {
  const calls: TaskCommand[] = [];
  const result = await taskWriteWithFreshness(
    deps(calls),
    "agent-1",
    command({ continueAnyway: true }),
    "#c",
    "key",
  );
  expect(result).toMatchObject({ tasks: [] });
  expect(calls).toEqual([
    { ...command({ continueAnyway: true }), idempotencyKey: expect.any(String) },
  ]);
});
