import { afterAll, beforeEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { AgentConsumedSeqState } from "#src/persistence/agent-consumed-seq-store";
import { seedCursor } from "./fixtures/consumed-cursor";
import { harness, workspaceRoot } from "./fixtures/mention-delivery-harness";

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));
// Everything up to sequence 5 of #general counts as read: a mention for it is already consumed.
beforeEach(() => {
  const state: AgentConsumedSeqState = {
    targets: { "#general": { conversationId: "conversation-a", seq: 5 } },
    aliases: {},
    nextReadOrder: 1,
  };
  return seedCursor("agent-a", state, workspaceRoot);
});

// The reference Computer checks a mention's identity before it asks whether the Agent consumed
// it, so a consumed mention that names no launch this Agent runs is an error, never an ACK.

test("a consumed mention naming another launch is refused as drift, not ACKed", async () => {
  const { runtime, frames, notices, envelope, deliver } = await harness();
  try {
    await deliver(2, envelope(2, { launchId: "launch-before" }));

    expect(notices).toEqual([]);
    expect(frames).toEqual([
      { kind: "terminal", deliveryId: "delivery-2", code: "IDENTITY_DRIFT" },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("a consumed mention for a running Agent that never reported its session is refused as unknown", async () => {
  const { runtime, frames, envelope, deliver } = await harness({ reportSession: false });
  try {
    await deliver(2, envelope(2));

    expect(frames).toEqual([
      { kind: "terminal", deliveryId: "delivery-2", code: "IDENTITY_UNKNOWN" },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("a consumed mention for a stopped Agent is refused as unknown, not ACKed", async () => {
  const { runtime, frames, envelope, deliver } = await harness();
  try {
    await runtime.stopAgent("agent-a");
    await deliver(2, envelope(2));

    expect(frames).toEqual([
      { kind: "terminal", deliveryId: "delivery-2", code: "IDENTITY_UNKNOWN" },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("a consumed mention naming another launch is refused as drift for an Agent whose process exited", async () => {
  const { runtime, frames, envelope, deliver, exit } = await harness();
  try {
    exit();
    await deliver(2, envelope(2, { launchId: "launch-before" }));

    expect(frames).toEqual([
      { kind: "terminal", deliveryId: "delivery-2", code: "IDENTITY_DRIFT" },
    ]);
  } finally {
    await runtime.stop();
  }
});
