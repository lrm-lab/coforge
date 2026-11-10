import { afterAll, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { AgentConsumedSeqState } from "#src/persistence/agent-consumed-seq-store";
import { AgentRuntimeBackoffStore } from "#src/persistence/agent-runtime-backoff-store";
import { seedCursor } from "./fixtures/consumed-cursor";
import { config, connection, harness, workspaceRoot } from "./fixtures/mention-delivery-harness";

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));
beforeEach(() =>
  seedCursor(
    "agent-a",
    { targets: {}, aliases: {}, nextReadOrder: 1 } as AgentConsumedSeqState,
    workspaceRoot,
  ),
);

/** A runtime-error backoff of Agent `agent-a` that ends `inMs` from now, as a Daemon that crashed
 * with it would have left it for the one that starts next. */
const backoffEndingIn = (inMs: number) =>
  new AgentRuntimeBackoffStore(() => workspaceRoot, "previous-process").save("agent-a", {
    untilMs: Date.now() + inMs,
    reason: "runtime_error_backoff",
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a mention held by a backoff waits for it, then wakes the Agent and is told once", async () => {
  backoffEndingIn(400);
  const { runtime, frames, notices, envelope, deliver, exit, launches, frameSent } =
    await harness();
  try {
    const mention = envelope(1);
    exit();
    await deliver(1, mention);

    // Nothing is told or answered while the backoff lasts, and nothing is launched for it.
    await sleep(150);
    expect(launches()).toBe(1);
    expect(notices).toEqual([]);
    expect(frames.filter((frame) => frame.kind !== "transition")).toEqual([]);

    await frameSent((frame) => frame.kind === "ack");
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

test("a held mention whose wake fails stays pending and is told by the launch after the cooldown", async () => {
  backoffEndingIn(300);
  const { runtime, frames, notices, envelope, deliver, exit, launches, frameSent } = await harness({
    failLaunches: [2],
  });
  try {
    exit();
    await deliver(1, envelope(1));
    await frameSent((frame) => frame.kind === "ack");

    // No delivery started the failed launch, so none was the one to refuse.
    expect(launches()).toBe(3);
    expect(notices).toHaveLength(1);
    expect(frames.filter((frame) => frame.kind === "terminal")).toEqual([]);
  } finally {
    await runtime.stop();
  }
});

test("a Stop forgets a held mention without a report, and the end of the backoff launches nothing", async () => {
  backoffEndingIn(300);
  const { runtime, frames, envelope, deliver, exit, launches } = await harness();
  try {
    exit();
    await deliver(1, envelope(1));
    await runtime.stopAgent("agent-a");

    await sleep(500);
    expect(launches()).toBe(1);
    expect(frames.filter((frame) => frame.kind !== "transition")).toEqual([]);
  } finally {
    await runtime.stop();
  }
});

test("the server's re-issue of a mention a Stop forgot is told once by the next launch", async () => {
  backoffEndingIn(60_000);
  const { runtime, frames, envelope, deliver, exit, launches, frameSent } = await harness();
  try {
    exit();
    await deliver(1, envelope(1));
    await runtime.stopAgent("agent-a");
    await runtime.startAgent("agent-a", config);
    await deliver(1, envelope(1));
    await frameSent((frame) => frame.kind === "ack");

    expect(launches()).toBe(2);
    expect(frames.filter((frame) => frame.kind === "terminal")).toEqual([]);
    expect(frames.filter((frame) => frame.kind === "ack")).toHaveLength(1);
  } finally {
    await runtime.stop();
  }
});

test("an inbox purge refuses a held mention of the purged conversation once", async () => {
  backoffEndingIn(60_000);
  const { runtime, frames, envelope, deliver, exit, frameSent } = await harness();
  try {
    exit();
    await deliver(1, envelope(1));
    runtime.handleAgentInboxPurge({
      protocolMajor: 1,
      requestId: "purge-1",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      conversationIds: ["conversation-a"],
      targets: ["#general"],
      reason: "member_removed",
    });
    await frameSent((frame) => frame.kind === "terminal");

    expect(frames.filter((frame) => frame.kind === "terminal")).toEqual([
      { kind: "terminal", deliveryId: "delivery-1", code: "DELIVERY_REJECTED" },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("a Daemon that stops forgets a held mention without a report", async () => {
  backoffEndingIn(60_000);
  const { runtime, frames, envelope, deliver, exit } = await harness();
  exit();
  await deliver(1, envelope(1));

  await runtime.stop();

  expect(frames.filter((frame) => frame.kind !== "transition")).toEqual([]);
});

test("a held mention repeated for the same launch is coalesced, not held twice", async () => {
  backoffEndingIn(400);
  const { runtime, frames, notices, envelope, deliver, exit, frameSent } = await harness();
  try {
    exit();
    await deliver(1, envelope(1));
    await deliver(1, envelope(1));
    await frameSent((frame) => frame.kind === "ack");

    expect(notices).toHaveLength(1);
    expect(frames.filter((frame) => frame.kind === "ack")).toHaveLength(1);
    expect(frames.filter((frame) => frame.kind === "terminal")).toEqual([]);
  } finally {
    await runtime.stop();
  }
});

test("a server Start that fails refuses a held mention once as unknown", async () => {
  backoffEndingIn(60_000);
  const { runtime, frames, envelope, deliver, exit, frameSent } = await harness({
    failLaunches: [2],
  });
  try {
    exit();
    await deliver(1, envelope(1));
    await runtime
      .handleAgentStart({
        protocolMajor: 1,
        requestId: "start-2",
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        agentId: "agent-a",
        ...config,
        controlEpoch: 1,
        launchId: "launch-2",
      })
      .catch(() => {});
    await frameSent((frame) => frame.kind === "terminal");

    expect(frames.filter((frame) => frame.kind === "terminal")).toEqual([
      { kind: "terminal", deliveryId: "delivery-1", code: "IDENTITY_UNKNOWN" },
    ]);
  } finally {
    await runtime.stop();
  }
});
