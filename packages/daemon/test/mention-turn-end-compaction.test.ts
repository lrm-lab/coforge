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

// The reference Computer holds a turn end's settlement only for a compaction its Pi driver reports
// as started after the run ended. Nothing of ours reports that (Pi's `agent_settled`, our turn end,
// follows the compaction), so a turn ending with a compaction still open settles as any turn end
// does, as the reference Computer does for every other compaction.

test("a turn that ends while a compaction is open still drains the mention it told", async () => {
  const { runtime, frames, envelope, deliver, emit } = await harness();
  try {
    emit({ type: "progress" });
    emit({ type: "compaction-started" });
    await deliver(1, envelope(1));
    expect(frames.some((frame) => frame.kind === "ack")).toBe(false);

    emit({ type: "completed", status: "completed" });

    expect(frames.at(-1)).toEqual({
      kind: "ack",
      deliveryId: "delivery-1",
      mentionDelivery: envelope(1),
    });
  } finally {
    await runtime.stop();
  }
});
