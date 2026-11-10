import { afterAll, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { AgentConsumedSeqState } from "#src/persistence/agent-consumed-seq-store";
import { seedCursor } from "./fixtures/consumed-cursor";
import { harness, workspaceRoot } from "./fixtures/mention-delivery-harness";

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));
beforeEach(() =>
  seedCursor(
    "agent-a",
    { targets: {}, aliases: {}, nextReadOrder: 1 } as AgentConsumedSeqState,
    workspaceRoot,
  ),
);

test("an idle Agent is woken by a mention and tells it once", async () => {
  const { runtime, frames, notices, envelope, deliver, exit, launches, frameSent } =
    await harness();
  try {
    const mention = envelope(1);
    exit();
    await deliver(1, mention);
    await frameSent((frame) => frame.kind === "ack");

    // Kept against the last reported launch, told once by the woken one.
    expect(launches()).toBe(2);
    expect(notices).toHaveLength(1);
    expect(frames.filter((frame) => frame.kind === "terminal")).toEqual([]);
    expect(frames.at(-1)).toEqual({
      kind: "ack",
      deliveryId: "delivery-1",
      mentionDelivery: mention,
    });
  } finally {
    await runtime.stop();
  }
});

test("a mention whose wake fails is rejected, not left waiting", async () => {
  const { runtime, frames, envelope, deliver, exit, frameSent } = await harness({
    failLaunches: [2],
  });
  try {
    exit();
    await deliver(1, envelope(1));
    await frameSent((frame) => frame.kind === "terminal");

    expect(frames.filter((frame) => frame.kind === "terminal")).toEqual([
      { kind: "terminal", deliveryId: "delivery-1", code: "DELIVERY_REJECTED" },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("a mention kept through the launch-failure cooldown wakes the Agent when it ends", async () => {
  const { runtime, frames, notices, envelope, deliver, exit, launches, frameSent } = await harness({
    failLaunches: [2],
  });
  try {
    exit();
    await deliver(1, envelope(1));
    await frameSent((frame) => frame.kind === "terminal");

    // Inside the one-second cooldown: kept, and woken for when it ends.
    await deliver(2, envelope(2));
    expect(launches()).toBe(2);
    await frameSent((frame) => frame.kind === "ack" && frame.deliveryId === "delivery-2");

    expect(launches()).toBe(3);
    expect(notices).toHaveLength(1);
    expect(frames.filter((frame) => frame.kind === "terminal")).toHaveLength(1);
  } finally {
    await runtime.stop();
  }
});
