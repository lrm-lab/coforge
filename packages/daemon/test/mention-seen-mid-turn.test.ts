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

// The reference Computer ACKs a pending mention as soon as the model has seen the message, not
// when the turn ends.

test("a pending mention is ACKed as soon as the Agent's check shows it, mid-turn", async () => {
  const { runtime, frames, envelope, deliver, emit, check } = await harness({
    checkSequences: [1],
  });
  try {
    emit({ type: "progress" });
    await deliver(1, envelope(1));
    expect(frames.some((frame) => frame.kind === "ack")).toBe(false);

    await check();

    expect(frames.slice(2).map((frame) => frame.kind)).toEqual(["transition", "ack"]);
    expect(frames.at(-1)).toEqual({
      kind: "ack",
      deliveryId: "delivery-1",
      mentionDelivery: envelope(1),
    });
  } finally {
    await runtime.stop();
  }
});

test("a check that shows a different message leaves the mention pending until the turn ends", async () => {
  const { runtime, frames, envelope, deliver, emit, check } = await harness({
    checkSequences: [2],
  });
  try {
    emit({ type: "progress" });
    await deliver(1, envelope(1));

    await check();
    expect(frames.some((frame) => frame.kind === "ack")).toBe(false);

    emit({ type: "completed", status: "completed" });
    expect(frames.some((frame) => frame.kind === "ack")).toBe(true);
  } finally {
    await runtime.stop();
  }
});
