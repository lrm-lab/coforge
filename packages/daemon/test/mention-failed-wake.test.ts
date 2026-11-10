import { afterAll, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { AgentConsumedSeqState } from "#src/persistence/agent-consumed-seq-store";
import { seedCursor } from "./fixtures/consumed-cursor";
import { harness, workspaceRoot } from "./fixtures/mention-delivery-harness";

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));
beforeEach(() => {
  const state: AgentConsumedSeqState = { targets: {}, aliases: {}, nextReadOrder: 1 };
  return seedCursor("agent-a", state, workspaceRoot);
});

// The reference Computer refuses only the delivery whose arrival started a failed launch; the
// mentions buffered meanwhile stay pending for the next launch.

test("a failed wake refuses the mention that woke the Agent and keeps the others for the next launch", async () => {
  const launchGate = Promise.withResolvers<void>();
  const h = await harness({ launchGate: launchGate.promise, failLaunches: [2] });
  try {
    h.exit();
    await h.deliver(1, h.envelope(1));
    await h.launchStarted;
    // Arrives while the wake launch is still starting: kept for the launch that is coming.
    await h.deliver(2, h.envelope(2));
    launchGate.resolve();

    await h.frameSent((frame) => frame.kind === "terminal");
    expect(h.frames.filter((frame) => frame.kind === "terminal")).toEqual([
      { kind: "terminal", deliveryId: "delivery-1", code: "DELIVERY_REJECTED" },
    ]);

    // The cooldown wake launches again and the survivor is told once.
    await h.frameSent((frame) => frame.kind === "ack" && frame.deliveryId === "delivery-2");
    expect(h.launches()).toBe(3);
    expect(h.notices).toHaveLength(1);
    expect(h.frames.filter((frame) => frame.kind === "terminal")).toHaveLength(1);
  } finally {
    launchGate.resolve();
    await h.runtime.stop();
  }
});
