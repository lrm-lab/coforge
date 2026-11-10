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

// The reference Computer folds the mentions kept for a launch into that launch's first input, and
// counts each as told by its delivery id.

test("the mentions kept for a launch are told in one notice, by delivery id, and each is ACKed", async () => {
  const launchGate = Promise.withResolvers<void>();
  const h = await harness({ launchGate: launchGate.promise });
  try {
    // Both name the launch that ran when the server issued them.
    const [first, second] = [h.envelope(1), h.envelope(2)];
    h.exit();
    await h.deliver(1, first);
    await h.launchStarted;
    await h.deliver(2, second);
    launchGate.resolve();

    await h.frameSent((frame) => frame.kind === "ack" && frame.deliveryId === "delivery-2");
    await h.frameSent((frame) => frame.kind === "ack" && frame.deliveryId === "delivery-1");

    expect(h.notices).toHaveLength(1);
    expect(h.noticeDeliveryIds).toEqual([["delivery-1", "delivery-2"]]);
    expect(h.frames.filter((frame) => frame.kind === "terminal")).toEqual([]);
    expect(h.frames.filter((frame) => frame.kind === "ack")).toEqual([
      { kind: "ack", deliveryId: "delivery-1", mentionDelivery: first },
      { kind: "ack", deliveryId: "delivery-2", mentionDelivery: second },
    ]);
  } finally {
    launchGate.resolve();
    await h.runtime.stop();
  }
});

test("a delivery held for the launch and a mention kept for it are told in the same notice", async () => {
  const launchGate = Promise.withResolvers<void>();
  const h = await harness({ launchGate: launchGate.promise, failLaunches: [2] });
  try {
    const [first, second] = [h.envelope(1), h.envelope(2)];
    h.exit();
    await h.deliver(1, first);
    await h.launchStarted;
    await h.deliver(2, second);
    // The wake launch fails: the first mention is refused, the second stays kept, and a plain
    // delivery that arrives within the cooldown is held for the launch after it.
    launchGate.resolve();
    await h.frameSent((frame) => frame.kind === "terminal");
    await h.deliver(3);

    await h.frameSent((frame) => frame.kind === "ack" && frame.deliveryId === "delivery-2");
    await h.frameSent((frame) => frame.kind === "ack" && frame.deliveryId === "delivery-3");

    expect(h.launches()).toBe(3);
    expect(h.notices).toHaveLength(1);
    expect(h.noticeDeliveryIds).toEqual([["delivery-2"]]);
    expect(h.notices[0]).toContain("2");
  } finally {
    launchGate.resolve();
    await h.runtime.stop();
  }
});
