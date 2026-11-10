import { afterAll, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { AgentConsumedSeqState } from "#src/persistence/agent-consumed-seq-store";
import { seedCursor } from "./fixtures/consumed-cursor";
import { config, connection, harness, workspaceRoot } from "./fixtures/mention-delivery-harness";

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));
beforeEach(() => {
  const state: AgentConsumedSeqState = { targets: {}, aliases: {}, nextReadOrder: 1 };
  return seedCursor("agent-a", state, workspaceRoot);
});

/** A server Start of the stopped Agent, held in its launch until `launchGate` opens. */
const serverStart = (h: Awaited<ReturnType<typeof harness>>) =>
  h.runtime.handleAgentStart({
    protocolMajor: 1,
    requestId: "start-2",
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    agentId: "agent-a",
    ...config,
    controlEpoch: 1,
    launchId: "launch-2",
  });

// The reference Computer buffers every delivery that arrives while a server Start is in flight,
// unacknowledged, and replays it through the ordinary handler once the Start has launched.

test("a mention that arrives while a server Start is launching is told to the launch it started", async () => {
  const launchGate = Promise.withResolvers<void>();
  const h = await harness({ launchGate: launchGate.promise });
  try {
    await h.runtime.stopAgent("agent-a");
    const start = serverStart(h);
    await h.launchStarted;
    await h.deliver(1, h.envelope(1, { launchId: "launch-2" }));
    expect(h.frames).toEqual([]);

    launchGate.resolve();
    await start;
    await h.frameSent((frame) => frame.kind === "ack");

    expect(h.notices).toHaveLength(1);
    expect(h.frames.filter((frame) => frame.kind === "terminal")).toEqual([]);
    expect(h.frames.at(-1)).toEqual({
      kind: "ack",
      deliveryId: "delivery-1",
      mentionDelivery: h.envelope(1, { launchId: "launch-2" }),
    });
  } finally {
    launchGate.resolve();
    await h.runtime.stop();
  }
});

test("a buffered mention whose envelope names another launch is refused as drift once the Start launched", async () => {
  const launchGate = Promise.withResolvers<void>();
  const h = await harness({ launchGate: launchGate.promise });
  try {
    await h.runtime.stopAgent("agent-a");
    const start = serverStart(h);
    await h.launchStarted;
    await h.deliver(1, h.envelope(1, { launchId: "launch-before" }));

    launchGate.resolve();
    await start;
    await h.frameSent((frame) => frame.kind === "terminal");

    expect(h.notices).toEqual([]);
    expect(h.frames).toEqual([
      { kind: "terminal", deliveryId: "delivery-1", code: "IDENTITY_DRIFT" },
    ]);
  } finally {
    launchGate.resolve();
    await h.runtime.stop();
  }
});

test("a buffered mention is dropped without a report when a Stop ends the Start", async () => {
  const launchGate = Promise.withResolvers<void>();
  const h = await harness({ launchGate: launchGate.promise });
  try {
    await h.runtime.stopAgent("agent-a");
    const start = serverStart(h);
    start.catch(() => {});
    await h.launchStarted;
    await h.deliver(1, h.envelope(1, { launchId: "launch-2" }));

    const stop = h.runtime.stopAgent("agent-a");
    launchGate.resolve();
    await stop;
    await start.catch(() => {});

    expect(h.notices).toEqual([]);
    expect(h.frames).toEqual([]);
  } finally {
    launchGate.resolve();
    await h.runtime.stop();
  }
});
