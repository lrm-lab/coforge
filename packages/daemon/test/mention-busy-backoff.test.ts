import { afterAll, afterEach, beforeEach, expect, jest, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { AgentConsumedSeqState } from "#src/persistence/agent-consumed-seq-store";
import { seedCursor } from "./fixtures/consumed-cursor";
import { harness, workspaceRoot } from "./fixtures/mention-delivery-harness";

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));
afterEach(() => jest.useRealTimers());
beforeEach(() => {
  const state: AgentConsumedSeqState = { targets: {}, aliases: {}, nextReadOrder: 1 };
  return seedCursor("agent-a", state, workspaceRoot);
});

// The reference Computer queues a mention for a process mid-turn whatever the backoff, and settles
// it when the turn ends; only an idle process answers QUOTA_LIMITED or DELIVERY_REJECTED.

for (const [kind, message] of [
  ["rate-limit", "429 Too Many Requests"],
  ["runtime-error", "connect ECONNRESET"],
] as const) {
  test(`a ${kind} backoff does not refuse a mention for an Agent mid-turn: it stays pending until the turn ends`, async () => {
    const { runtime, frames, notices, envelope, deliver, emit } = await harness();
    jest.useFakeTimers();
    try {
      emit({ type: "progress" });
      emit({ type: "error", message });
      await deliver(1, envelope(1));

      expect(notices).toHaveLength(1);
      expect(frames).toEqual([
        {
          kind: "transition",
          deliveryId: "delivery-1",
          stage: "daemon_received",
          outcome: "accepted",
        },
        {
          kind: "transition",
          deliveryId: "delivery-1",
          stage: "daemon_pending",
          outcome: "accepted",
        },
      ]);

      emit({ type: "completed", status: "failed" });
      expect(frames.slice(2).map((frame) => frame.kind)).toEqual(["transition", "ack"]);
    } finally {
      await runtime.stop();
    }
  });
}
