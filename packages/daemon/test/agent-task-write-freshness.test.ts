import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig } from "@lrm/coforge-anvil";
import type { AgentMessageRequest, TaskRequest } from "@lrm/coforge-sdk/internal";
import type { WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { createMessageHarness } from "./fixtures/message-harness";
import { messageRecord } from "./fixtures/message-record";

const root = realpathSync(tmpdir());
const workspaceRoot = join(root, `coforge-daemon-task-freshness-${crypto.randomUUID()}`);
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};
const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};
const messageHarness = createMessageHarness({ connection, config });

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));
beforeEach(async () => rm(".coforge-daemon-state", { recursive: true, force: true }));

describe("Agent Task write freshness", () => {
  test("create, claim, and assign are blocked by unread target context", async () => {
    for (const command of [
      { operation: "create" as const, title: "new task" },
      { operation: "claim" as const, number: 7 },
      { operation: "assign" as const, number: 7, assignee: "@agent-a" },
    ]) {
      const taskCalls: TaskRequest[] = [];
      const harness = await messageHarness(
        async (request) => ({
          idempotencyKey: request.idempotencyKey,
          accepted: true,
          attentionCount: 1,
          messages: [messageRecord(4, "@alice", request.target)],
        }),
        async (request) => {
          taskCalls.push(request);
          return { idempotencyKey: request.idempotencyKey, tasks: [] };
        },
      );
      try {
        await harness.deliver(4, "#tasks");
        const result = await harness.runtime.agentTask(
          harness.context,
          { ...command, idempotencyKey: command.operation, target: "#tasks" },
          harness.apiKey,
        );
        expect(result).toMatchObject({ state: "held", newMessageCount: 1 });
        expect(taskCalls).toHaveLength(0);
      } finally {
        await harness.runtime.stop();
      }
    }
  });

  test("allowed task writes attach unread context and forward the seen boundary", async () => {
    const messageCalls: AgentMessageRequest[] = [];
    const taskCalls: TaskRequest[] = [];
    const harness = await messageHarness(
      async (request) => {
        messageCalls.push(request);
        return {
          idempotencyKey: request.idempotencyKey,
          accepted: true,
          attentionCount: 1,
          messages: [messageRecord(2, "@alice", "#tasks")],
        };
      },
      async (request) => {
        taskCalls.push(request);
        return { idempotencyKey: request.idempotencyKey, tasks: [] };
      },
    );
    try {
      await harness.deliver(2, "#tasks");
      const result = await harness.runtime.agentTask(
        harness.context,
        { operation: "amend", idempotencyKey: "amend", target: "#tasks", number: 7, title: "new" },
        harness.apiKey,
      );
      expect(result).toMatchObject({
        recentUnread: [messageRecord(2, "@alice", "#tasks")],
        newMessageCount: 1,
      });
      expect(messageCalls).toHaveLength(1);
      expect(taskCalls[0]).toMatchObject({ seenUpToSeq: 2 });
    } finally {
      await harness.runtime.stop();
    }
  });
});
