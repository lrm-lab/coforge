import { expect, test } from "bun:test";
import {
  AGENT_CONTEXT_VIEW_CLIENT_DEADLINE_MS,
  awaitAgentContextView,
} from "#src/features/agents/agent-context-view-poll";
import type { AgentContextViewRead } from "#src/server/computers/computer-agent-context-views.server";

/** A clock the test advances only by sleeping, and a read that answers from a script. */
function harness(script: Array<AgentContextViewRead | Error>) {
  let now = 0;
  let reads = 0;
  const controller = new AbortController();
  return {
    controller,
    reads: () => reads,
    run: (options: { deadlineMs?: number } = {}) =>
      awaitAgentContextView({
        read: async () => {
          const next = script[Math.min(reads++, script.length - 1)]!;
          if (next instanceof Error) throw next;
          return next;
        },
        signal: controller.signal,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        ...options,
      }),
  };
}

test("polls while pending and returns the Computer's result", async () => {
  const { run, reads } = harness([
    { status: "pending" },
    { status: "pending" },
    { status: "unavailable", reason: "agent_moved" },
  ]);
  expect(await run()).toEqual({ status: "unavailable", reason: "agent_moved" });
  expect(reads()).toBe(3);
});

test("asks again after a read that failed", async () => {
  const { run } = harness([new Error("gateway"), { status: "unsupported" }]);
  expect(await run()).toEqual({ status: "unsupported" });
});

test("no result by the deadline ends as the old-daemon timeout", async () => {
  const { run } = harness([{ status: "pending" }]);
  expect(await run()).toEqual({ status: "timeout", reason: "old_daemon" });
});

test("the caller going away ends the wait", async () => {
  const { run, controller, reads } = harness([{ status: "pending" }]);
  controller.abort();
  expect(await run()).toEqual({ status: "timeout", reason: "old_daemon" });
  expect(reads()).toBe(0);
});

test("the deadline outlasts the Computer's 25 second restore and ends inside the 35 second result lifetime", () => {
  expect(AGENT_CONTEXT_VIEW_CLIENT_DEADLINE_MS).toBeGreaterThan(25_000);
  expect(AGENT_CONTEXT_VIEW_CLIENT_DEADLINE_MS).toBeLessThan(35_000);
});
