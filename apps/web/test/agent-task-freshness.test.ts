import { describe, expect, test } from "bun:test";

import { executeAgentTaskWithFreshness } from "#src/server/agents/agent-task-freshness.server";
import type { AgentTargetFreshness } from "#src/server/agents/agent-target-freshness.server";
import type { AgentMessageRecord } from "#src/server/agents/agent-messages.server";

const principal = { workspaceId: "workspace-1", agentId: "agent-1" };
const record = (sequence: number): AgentMessageRecord =>
  ({
    id: `m${sequence}`,
    sequence,
    senderKind: "human",
    senderHandle: "ada",
    senderDescription: "",
    target: "#tasks",
    body: `message ${sequence}`,
    createdAt: new Date("2026-11-02T00:00:00Z"),
    attachments: [],
  }) as AgentMessageRecord;

const freshness = (pending: number[] = [], recent: number[] = []): AgentTargetFreshness => ({
  readPending: async () => pending.slice(-3).map(record),
  countPending: async () => pending.length,
  maxPendingSequence: async () => Math.max(0, ...pending) || undefined,
  readRecent: async (limit: number) => ({
    unseen: recent.slice(-limit).map(record),
    maxSequence: recent.length ? Math.max(...recent) : undefined,
  }),
  readThrough: async () => 0,
  advanceReadThrough: async (sequence: number) => sequence,
});

describe("Agent task write freshness", () => {
  test("create, claim and assign are held over pending context the Agent did not see", async () => {
    let executed = 0;
    for (const operation of ["create", "claim", "assign"] as const) {
      const result = await executeAgentTaskWithFreshness(
        {
          board: {
            execute: async () => {
              executed++;
              return { tasks: [] };
            },
          },
          freshness: async () => ({ freshness: freshness([4]), scope: {} as never }),
        },
        principal,
        { operation, idempotencyKey: operation, target: "#tasks" },
      );
      expect(result).toMatchObject({
        state: "held",
        heldMessages: [{ sequence: 4 }],
        newMessageCount: 1,
      });
    }
    expect(executed).toBe(0);
  });

  test("continueAnyway executes a held operation and advances over the held context", async () => {
    let executed = 0;
    let advancedTo: number | undefined;
    const withAdvanced = freshness([4, 5], [4, 5]);
    withAdvanced.advanceReadThrough = async (sequence: number) => {
      advancedTo = sequence;
      return sequence;
    };
    for (const operation of ["create", "claim", "assign"] as const) {
      const result = await executeAgentTaskWithFreshness(
        {
          board: {
            execute: async () => {
              executed++;
              return { tasks: [] };
            },
          },
          freshness: async () => ({ freshness: withAdvanced, scope: {} as never }),
        },
        principal,
        { operation, idempotencyKey: operation, target: "#tasks", continueAnyway: true },
      );
      expect(result.state).toBeUndefined();
    }
    expect(executed).toBe(3);
    expect(advancedTo).toBe(5);
  });

  test("a held operation reports only the count under reviewer isolation", async () => {
    const result = await executeAgentTaskWithFreshness(
      {
        board: { execute: async () => ({ tasks: [] }) },
        freshness: async () => ({ freshness: freshness([4, 5]), scope: {} as never }),
      },
      principal,
      {
        operation: "claim",
        idempotencyKey: "claim",
        target: "#tasks",
        freshnessContextMode: "withheld",
      },
    );
    expect(result).toEqual({
      tasks: [],
      state: "held",
      freshnessContextMode: "withheld",
      withheldMessageCount: 2,
    });
  });

  test("unclaim, update and amend execute and attach what the Agent missed", async () => {
    for (const operation of ["unclaim", "update", "amend"] as const) {
      const result = await executeAgentTaskWithFreshness(
        {
          board: { execute: async () => ({ tasks: [] }) },
          freshness: async () => ({ freshness: freshness([4, 5, 6, 7]), scope: {} as never }),
        },
        principal,
        { operation, idempotencyKey: operation, target: "#tasks", number: 7 },
      );
      expect(result).toMatchObject({
        tasks: [],
        recentUnread: [{ sequence: 5 }, { sequence: 6 }, { sequence: 7 }],
        newMessageCount: 4,
      });
      expect(result.recentUnread?.[0]?.createdAt).toBe("2026-11-02T00:00:00.000Z");
    }
  });

  test("the Agent's reported boundary settles what it already reviewed", async () => {
    let executed = 0;
    const result = await executeAgentTaskWithFreshness(
      {
        board: {
          execute: async () => {
            executed++;
            return { tasks: [] };
          },
        },
        freshness: async () => ({ freshness: freshness([]), scope: {} as never }),
      },
      principal,
      {
        operation: "claim",
        idempotencyKey: "claim",
        target: "#tasks",
        number: 7,
        seenUpToSeq: 9,
      },
    );
    expect(result).toEqual({ tasks: [] });
    expect(executed).toBe(1);
  });

  test("a first-touch create is held over the target's recent context", async () => {
    let executed = 0;
    const result = await executeAgentTaskWithFreshness(
      {
        board: {
          execute: async () => {
            executed++;
            return { tasks: [] };
          },
        },
        freshness: async () => ({ freshness: freshness([], [2, 3]), scope: {} as never }),
      },
      principal,
      { operation: "create", idempotencyKey: "create", target: "#tasks", title: "t" },
    );
    expect(result).toMatchObject({ state: "held", newMessageCount: 2 });
    expect(executed).toBe(0);
  });

  test("operations outside the gate pass through untouched, and no freshness means no gate", async () => {
    let executed = 0;
    const board = {
      execute: async () => {
        executed++;
        return { tasks: [] };
      },
    };
    await executeAgentTaskWithFreshness(
      { board, freshness: async () => ({ freshness: freshness([9]), scope: {} as never }) },
      principal,
      { operation: "delete", idempotencyKey: "delete", target: "#tasks", number: 7 },
    );
    await executeAgentTaskWithFreshness({ board }, principal, {
      operation: "claim",
      idempotencyKey: "claim",
      target: "#tasks",
      number: 7,
    });
    expect(executed).toBe(2);
  });
});
