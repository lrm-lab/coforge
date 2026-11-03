import { afterAll, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskCommand } from "@lrm/coforge-sdk/internal";
import type { AgentMessageTransportResponse } from "#src/connection/agent-message-adapters";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";
import { AgentPreflightError } from "#src/daemon-runtime/agent-preflight-error";
import { taskHoldOffered } from "#src/daemon-runtime/agent-task-hold-offers";
import { taskWriteWithFreshness } from "#src/daemon-runtime/task-write-freshness";

// macOS tmpdir lives under /var, a symlink; the cursor store rejects linked ancestors.
const tempRoot = realpathSync(tmpdir());
const stateDirectories: string[] = [];
const temporaryStateDirectory = () => {
  const path = join(tempRoot, `coforge-task-freshness-${crypto.randomUUID()}`);
  stateDirectories.push(path);
  return path;
};

afterAll(async () => {
  await Promise.all(
    stateDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** The real attention index, composed with a durable consumed cursor exactly as the runtime does. */
const freshDeps = (agentId = "agent-1") => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentConsumedSeqStore(stateDirectory);
  const attention = new AgentMessageAttentionIndex(
    "workspace-1",
    {
      session: () => {
        throw new Error("task writes never talk to the session");
      },
    },
    async () => {},
    () => {},
    { shouldHold: () => false, enqueue: () => {}, busy: () => {}, consumedSeqs: store },
  );
  attention.bindConversation(agentId, "#c", "conversation-1");
  const readMessages: Array<{ sequence: number; target: string }> = [];
  const calls: TaskCommand[] = [];
  return {
    attention,
    calls,
    markRead: (sequence: number) => readMessages.push({ sequence, target: "#c" }),
    deps: {
      messageAttention: attention,
      agentMessage: async () =>
        ({
          idempotencyKey: "read",
          accepted: true,
          attentionCount: 0,
          messageId: "",
          summaries: [],
          messages: readMessages.map((message) => ({
            id: `m${message.sequence}`,
            ...message,
            senderKind: "human",
            senderHandle: "ada",
            senderDescription: "",
            body: "unread context",
            createdAt: "now",
            attachments: [],
          })),
        }) as AgentMessageTransportResponse,
      workspaceId: "workspace-1",
      agentTask: async (command: TaskCommand) => {
        calls.push(command);
        return { idempotencyKey: command.idempotencyKey, tasks: [] };
      },
    },
  };
};

const command = (overrides: Partial<TaskCommand> = {}): TaskCommand =>
  ({ idempotencyKey: "request", operation: "create", target: "#c", ...overrides }) as TaskCommand;

test("a create with unread context is held, and the shown messages are recorded", async () => {
  const fresh = freshDeps();
  fresh.markRead(9);
  const result = await taskWriteWithFreshness(fresh.deps, "agent-1", command(), "#c", "key");
  expect(result).toMatchObject({
    state: "held",
    heldMessages: [{ sequence: 9 }],
  });
  // The hold showed message 9: the boundary advanced over it and the hold was offered.
  expect(fresh.attention.modelSeenSequence("agent-1", "#c")).toBe(9);
  expect(taskHoldOffered("agent-1", "#c")).toBe(true);
});

test("an identical retry after a hold executes without --anyway", async () => {
  const fresh = freshDeps();
  fresh.markRead(9);
  const held = await taskWriteWithFreshness(fresh.deps, "agent-1", command(), "#c", "key");
  expect(held).toMatchObject({ state: "held" });

  const result = await taskWriteWithFreshness(fresh.deps, "agent-1", command(), "#c", "key");
  expect(result).toMatchObject({ idempotencyKey: "request", tasks: [] });
  expect(fresh.calls).toHaveLength(1);
});

test("--anyway right after a hold executes the write", async () => {
  const fresh = freshDeps();
  fresh.markRead(9);
  const held = await taskWriteWithFreshness(fresh.deps, "agent-1", command(), "#c", "key");
  expect(held).toMatchObject({ state: "held" });

  const result = await taskWriteWithFreshness(
    fresh.deps,
    "agent-1",
    command({ continueAnyway: true }),
    "#c",
    "key",
  );
  expect(result).toMatchObject({ idempotencyKey: "request", tasks: [] });
});

test("--anyway without a prior hold is refused as a local precondition", async () => {
  // A different Agent: the offer store is process-wide, and the earlier tests offered for agent-1.
  const fresh = freshDeps("agent-2");
  fresh.markRead(9);
  expect(
    taskWriteWithFreshness(fresh.deps, "agent-2", command({ continueAnyway: true }), "#c", "key"),
  ).rejects.toThrow(AgentPreflightError);
});
