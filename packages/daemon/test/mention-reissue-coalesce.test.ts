import { afterAll, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { AgentConsumedSeqState } from "#src/persistence/agent-consumed-seq-store";
import { seedCursor } from "./fixtures/consumed-cursor";
import { config, harness, workspaceRoot } from "./fixtures/mention-delivery-harness";

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));
beforeEach(() => {
  const state: AgentConsumedSeqState = { targets: {}, aliases: {}, nextReadOrder: 1 };
  return seedCursor("agent-a", state, workspaceRoot);
});

// The reference Computer keeps one entry per delivery: an issue that arrives while the first is
// not settled is coalesced into it, carrying the newest envelope, whatever launch it names.

test("a mention issued again for the next launch while it is still being told is coalesced", async () => {
  const gate = Promise.withResolvers<void>();
  const h = await harness({ noticeGate: gate.promise });
  try {
    const first = h.deliver(1, h.envelope(1));
    void first.catch(() => {});
    await h.noticeWritten;
    h.exit();
    await h.runtime.startAgent("agent-a", config);
    const reissued = h.envelope(1);
    h.frames.length = 0;

    await h.deliver(1, reissued);
    expect(h.frames).toEqual([
      {
        kind: "transition",
        deliveryId: "delivery-1",
        stage: "daemon_pending",
        outcome: "coalesced",
      },
    ]);

    // The first notice settles for a process the restart replaced: the launch tells the mention
    // once, and its ACK echoes the newest envelope.
    gate.resolve();
    await h.frameSent((frame) => frame.kind === "ack");
    expect(h.frames.filter((frame) => frame.kind === "terminal")).toEqual([]);
    expect(h.frames.at(-1)).toEqual({
      kind: "ack",
      deliveryId: "delivery-1",
      mentionDelivery: reissued,
    });
  } finally {
    gate.resolve();
    await h.runtime.stop();
  }
});
