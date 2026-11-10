import { afterAll, beforeEach, expect, jest, test } from "bun:test";
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

const AUTH = "access token could not be refreshed";
const HOUR_MS = 60 * 60_000;

/** A held Agent with a mention kept, whose process closed and whose probe launch, an hour later,
 * is running. */
async function probing() {
  const h = await harness();
  h.emit({ type: "progress" });
  h.emit({ type: "error", message: AUTH });
  h.emit({ type: "completed", status: "failed" });
  await h.deliver(1, h.envelope(1));
  jest.useFakeTimers();
  h.exit();
  jest.advanceTimersByTime(HOUR_MS);
  jest.useRealTimers();
  while (h.launches() < 2) await Bun.sleep(5);
  // The probe launch is listening once it has told what the hold kept.
  while (!h.noticeDeliveryIds.some((ids) => ids?.includes("delivery-1"))) await Bun.sleep(5);
  return h;
}

test("model output of the probe launch shows the credential works: the server is told once", async () => {
  const h = await probing();
  try {
    expect(h.restored).toEqual([]);
    h.emit({ type: "text-delta", text: "hello" });
    h.emit({ type: "text-delta", text: " again" });
    expect(h.restored).toMatchObject([
      { agentId: "agent-a", reason: "user_reauth", releaseCause: "model_output" },
    ]);
  } finally {
    jest.useRealTimers();
    await h.runtime.stop();
  }
});

test("output of the turn that met the failure never shows it", async () => {
  const h = await harness();
  try {
    h.emit({ type: "progress" });
    h.emit({ type: "error", message: AUTH });
    h.emit({ type: "text-delta", text: "partial" });
    expect(h.restored).toEqual([]);
    await h.deliver(1, h.envelope(1));
    expect(h.notices).toEqual([]);
  } finally {
    await h.runtime.stop();
  }
});

test("a Stop ends the record: the server is told the Agent's failure is over", async () => {
  const h = await harness();
  try {
    h.emit({ type: "progress" });
    h.emit({ type: "error", message: AUTH });
    h.emit({ type: "completed", status: "failed" });
    await h.runtime.stopAgent("agent-a");
    expect(h.restored).toMatchObject([
      { agentId: "agent-a", reason: "user_reauth", releaseCause: "explicit_stop" },
    ]);
  } finally {
    await h.runtime.stop();
  }
});
