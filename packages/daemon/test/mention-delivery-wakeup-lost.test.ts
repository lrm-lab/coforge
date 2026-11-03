import { afterAll, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { AgentConsumedSeqState } from "#src/persistence/agent-consumed-seq-store";
import { AgentWakeupUnavailableError } from "#src/daemon-runtime/agent-wakeup-unavailable-error";
import { seedCursor } from "./fixtures/consumed-cursor";
import { harness, workspaceRoot } from "./fixtures/mention-delivery-harness";

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));
// The consumed cursor outlives a runtime (it is durable), so each test starts from a clean one.
beforeEach(() => seed({ targets: {}, aliases: {}, nextReadOrder: 1 }));

/** Seeds the cursor the runtime under test reads: this file's Agent, in its own state directory. */
const seed = (state: AgentConsumedSeqState) => seedCursor("agent-a", state, workspaceRoot);

test("a wakeup that lost its session reports identity-unknown, so the server wakes and re-issues", async () => {
  const { runtime, frames, envelope, deliver } = await harness({
    notifyError: new AgentWakeupUnavailableError("the Agent's notice was cancelled"),
  });
  try {
    await expect(deliver(1, envelope(1))).rejects.toThrow("the Agent's notice was cancelled");

    expect(frames).toEqual([
      {
        kind: "transition",
        deliveryId: "delivery-1",
        stage: "daemon_received",
        outcome: "accepted",
      },
      // IDENTITY_UNKNOWN, not DELIVERY_REJECTED: the server answers it by waking the Agent and
      // re-issuing the pending mention for the relaunched session, instead of settling it lost.
      { kind: "terminal", deliveryId: "delivery-1", code: "IDENTITY_UNKNOWN" },
    ]);
  } finally {
    await runtime.stop();
  }
});
