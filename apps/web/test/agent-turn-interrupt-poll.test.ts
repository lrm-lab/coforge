import { expect, test } from "bun:test";
import {
  AGENT_TURN_INTERRUPT_RELEASE_TIMEOUT_MS,
  AGENT_TURN_INTERRUPT_TIMEOUT_MS,
} from "@lrm/coforge-daemon/src/daemon-runtime/turn-interrupt";
import {
  AGENT_TURN_INTERRUPT_CLIENT_DEADLINE_MS,
  interruptAgentTurnOutcome,
} from "#src/features/agents/agent-turn-interrupt-poll";
import { AGENT_TURN_INTERRUPT_RESULT_TTL_SECONDS } from "#src/server/agents/agent-turn-interrupt-results.server";
import type {
  AgentTurnInterruptRead,
  AgentTurnInterruptStart,
} from "#src/server/agents/agent-turn-interrupt.server";

const started: AgentTurnInterruptStart = { status: "started", requestId: "request-1" };

/** A clock the test advances only by sleeping, and reads that answer from a script. */
function harness(script: Array<AgentTurnInterruptRead | Error>, start = started) {
  let now = 0;
  let reads = 0;
  const requestIds: string[] = [];
  return {
    reads: () => reads,
    requestIds,
    run: (options: { deadlineMs?: number } = {}) =>
      interruptAgentTurnOutcome({
        start: async () => start,
        read: async (requestId) => {
          requestIds.push(requestId);
          const next = script[Math.min(reads++, script.length - 1)]!;
          if (next instanceof Error) throw next;
          return next;
        },
        ...options,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }),
  };
}

test("the deadline outlasts the Daemon's worst case and ends inside the stored result's lifetime", () => {
  // A native interrupt gets its budget, then a runtime restart gets its release timeout.
  const daemonWorstCaseMs =
    AGENT_TURN_INTERRUPT_TIMEOUT_MS + AGENT_TURN_INTERRUPT_RELEASE_TIMEOUT_MS;
  expect(AGENT_TURN_INTERRUPT_CLIENT_DEADLINE_MS).toBeGreaterThan(daemonWorstCaseMs);
  expect(AGENT_TURN_INTERRUPT_CLIENT_DEADLINE_MS).toBeLessThan(
    AGENT_TURN_INTERRUPT_RESULT_TTL_SECONDS * 1_000,
  );
});

test("polls the started request while pending and settles on the Computer's outcome", async () => {
  const { run, reads, requestIds } = harness([
    { status: "pending" },
    { status: "pending" },
    { status: "settled", outcome: "restarted" },
  ]);
  expect(await run()).toBe("restarted");
  expect(reads()).toBe(3);
  expect(requestIds).toEqual(["request-1", "request-1", "request-1"]);
});

test("a refusal ends the wait at once without reading", async () => {
  const { run, reads } = harness([{ status: "pending" }], {
    status: "refused",
    reason: "needs_upgrade",
  });
  expect(await run()).toBe("needs_upgrade");
  expect(reads()).toBe(0);
});

test("a read that fails on the way does not end the wait", async () => {
  const { run } = harness([
    new Error("network"),
    { status: "pending" },
    new Error("502"),
    { status: "settled", outcome: "interrupted" },
  ]);
  expect(await run()).toBe("interrupted");
});

test("a Computer that never answers ends as failed at the deadline", async () => {
  const { run } = harness([{ status: "pending" }]);
  expect(await run({ deadlineMs: 5_000 })).toBe("failed");
});

test("a start that fails ends as failed", async () => {
  expect(
    await interruptAgentTurnOutcome({
      start: async () => {
        throw new Error("not authorized");
      },
      read: async () => ({ status: "pending" }),
    }),
  ).toBe("failed");
});
