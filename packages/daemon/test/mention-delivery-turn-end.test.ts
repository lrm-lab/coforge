import { afterAll, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { AgentConsumedSeqState } from "#src/persistence/agent-consumed-seq-store";
import { seedCursor } from "./fixtures/consumed-cursor";
import { harness, workspaceRoot, type Frame } from "./fixtures/mention-delivery-harness";

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));
beforeEach(() =>
  seedCursor(
    "agent-a",
    { targets: {}, aliases: {}, nextReadOrder: 1 } as AgentConsumedSeqState,
    workspaceRoot,
  ),
);

const acks = (frames: readonly Frame[], deliveryId: string) =>
  frames.filter((frame) => frame.kind === "ack" && frame.deliveryId === deliveryId);

test("a turn's end settles every mention it told at once, not one report after another", async () => {
  const gate = Promise.withResolvers<void>();
  const { runtime, frames, envelope, deliver, emit, frameSent } = await harness({
    ackGate: gate.promise,
  });
  try {
    emit({ type: "progress" });
    await deliver(1, envelope(1));
    await deliver(2, envelope(2));

    // The first ACK stays in flight: the second mention does not wait for it.
    emit({ type: "completed", status: "completed" });
    await Promise.race([
      frameSent((frame) => frame.kind === "ack" && frame.deliveryId === "delivery-2"),
      Bun.sleep(200),
    ]);

    expect(acks(frames, "delivery-1")).toHaveLength(1);
    expect(acks(frames, "delivery-2")).toHaveLength(1);
  } finally {
    gate.resolve();
    await runtime.stop();
  }
});

test("a mention a turn's end drained is drained for a repeat arriving before its ACK was answered", async () => {
  const gate = Promise.withResolvers<void>();
  const { runtime, frames, envelope, deliver, emit, frameSent } = await harness({
    ackGate: gate.promise,
  });
  try {
    emit({ type: "progress" });
    await deliver(1, envelope(1));
    await deliver(2, envelope(2));
    emit({ type: "completed", status: "completed" });
    await frameSent((frame) => frame.kind === "ack" && frame.deliveryId === "delivery-1");

    void deliver(2, envelope(2));
    await Promise.race([
      frameSent((frame) => frame.kind === "ack" && frame.deliveryId === "delivery-2"),
      Bun.sleep(200),
    ]);

    // Settled by the turn's end: the repeat is ACKed again, never coalesced as still pending.
    expect(
      frames.filter(
        (frame) =>
          frame.kind === "transition" &&
          frame.deliveryId === "delivery-2" &&
          frame.outcome === "coalesced",
      ),
    ).toEqual([]);
    expect(acks(frames, "delivery-2").length).toBeGreaterThanOrEqual(1);
  } finally {
    gate.resolve();
    await runtime.stop();
  }
});
