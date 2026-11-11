import { afterAll, beforeEach, expect, jest, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { AgentConfigSync, AgentStartIntent } from "@lrm/coforge-sdk/internal";
import type { AgentConsumedSeqState } from "#src/persistence/agent-consumed-seq-store";
import { seedCursor } from "./fixtures/consumed-cursor";
import {
  config,
  connection,
  harness,
  workspaceRoot,
  type Frame,
} from "./fixtures/mention-delivery-harness";

afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));
beforeEach(() =>
  seedCursor(
    "agent-a",
    { targets: {}, aliases: {}, nextReadOrder: 1 } as AgentConsumedSeqState,
    workspaceRoot,
  ),
);

// While an Agent's provider credential is known invalid, the reference Computer keeps its process
// and holds what it would be told: a tracked mention stays unanswered, an untracked delivery is
// kept ACKed, and the next launch (a restart, a Start) tells them once.

const AUTH = "access token could not be refreshed";

/** A launched Agent whose turn just failed on `message`. */
async function failed(message = AUTH, options: Parameters<typeof harness>[0] = {}) {
  const h = await harness(options);
  h.emit({ type: "progress" });
  h.emit({ type: "error", message });
  h.emit({ type: "completed", status: "failed" });
  return h;
}

/** Resolves once a notice written to the session carried `deliveryId`. */
async function told(h: Awaited<ReturnType<typeof failed>>, deliveryId: string) {
  while (!h.noticeDeliveryIds.some((ids) => ids?.includes(deliveryId))) await Bun.sleep(5);
}

const CLOSED_HOLD_MS = 60 * 60_000;

const push = (changes: Partial<AgentConfigSync>): AgentConfigSync => ({
  protocolMajor: 1,
  workspaceId: connection.workspaceId,
  computerId: connection.computerId,
  agentId: "agent-a",
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
  revision: 2,
  ...changes,
});

/** A server Start: the one intent a person's press of Start/Retry produces. */
const startIntent = (overrides: Partial<AgentStartIntent> = {}): AgentStartIntent => ({
  protocolMajor: 1,
  requestId: "start-request",
  workspaceId: connection.workspaceId,
  computerId: connection.computerId,
  agentId: "agent-a",
  ...config,
  ...overrides,
});

const terminals = (frames: readonly Frame[]) => frames.filter((frame) => frame.kind === "terminal");

for (const [kind, message, action] of [
  ["an auth failure", AUTH, "user_reauth"],
  [
    "a plan that lacks the model",
    "Your plan does not include access to this model",
    "user_model_access",
  ],
  ["an exhausted balance", "HTTP 402 Payment Required: insufficient balance", undefined],
] as const) {
  test(`${kind} keeps the process and the Agent active, with the failure's Activity`, async () => {
    const h = await failed(message);
    try {
      expect(h.disposals()).toBe(0);
      expect(h.statuses.some((status) => status.status === "inactive")).toBe(false);
      const activity = h.activities.findLast((each) => each.detailKind === "runtime_error")!;
      expect(activity.runtimeError?.requiredAction).toBe(action);
      expect(activity.detail).not.toContain(message);
    } finally {
      await h.runtime.stop();
    }
  });
}

test("a tracked mention for a held Agent is kept: not told, not answered, not refused", async () => {
  const h = await failed();
  try {
    await h.deliver(1, h.envelope(1));
    expect(h.notices).toEqual([]);
    expect(h.frames).toEqual([
      {
        kind: "transition",
        deliveryId: "delivery-1",
        stage: "daemon_received",
        outcome: "accepted",
      },
    ]);
  } finally {
    await h.runtime.stop();
  }
});

test("a mention kept by the hold is told once by the launch an hour after the process closed", async () => {
  const h = await failed();
  try {
    await h.deliver(1, h.envelope(1));
    await h.deliver(1, h.envelope(1, { launchId: "launch-reissued" }));
    expect(h.frames.at(-1)).toMatchObject({ kind: "transition", outcome: "coalesced" });

    // The process closes; the hold outlives it, so a message for the closed Agent does not wake it.
    jest.useFakeTimers();
    h.exit();
    await h.deliver(2);
    expect(h.launches()).toBe(1);

    // After the hour the Agent starts to probe the credential and tells what it kept.
    jest.advanceTimersByTime(CLOSED_HOLD_MS);
    jest.useRealTimers();
    await told(h, "delivery-1");
    h.emit({ type: "completed", status: "completed" });
    await h.frameSent((frame) => frame.kind === "ack" && frame.deliveryId === "delivery-1");

    expect(h.launches()).toBe(2);
    expect(h.noticeDeliveryIds.filter((ids) => ids?.includes("delivery-1"))).toHaveLength(1);
    expect(terminals(h.frames)).toEqual([]);
    expect(h.frames.at(-1)).toMatchObject({
      kind: "ack",
      deliveryId: "delivery-1",
      mentionDelivery: { launchId: "launch-reissued" },
    });
  } finally {
    jest.useRealTimers();
    await h.runtime.stop();
  }
});

test("untracked deliveries for a closed held Agent wait ACKed and are presented together by its probe launch", async () => {
  const h = await failed();
  try {
    await h.deliver(1);
    jest.useFakeTimers();
    h.exit();
    await h.deliver(2);
    expect(h.launches()).toBe(1);
    expect(h.notices).toEqual([]);
    jest.advanceTimersByTime(CLOSED_HOLD_MS);
    jest.useRealTimers();
    await h.frameSent((frame) => frame.kind === "ack" && frame.deliveryId === "delivery-2");
    while (h.notices.length === 0) await Bun.sleep(5);
    expect(h.launches()).toBe(2);
    expect(h.notices.at(-1)).toContain("2 new messages");
  } finally {
    jest.useRealTimers();
    await h.runtime.stop();
  }
});

test("a later retryable failure does not end the hold", async () => {
  const h = await failed();
  try {
    h.emit({ type: "error", message: "connect ECONNRESET" });
    h.emit({ type: "completed", status: "failed" });
    await h.deliver(1, h.envelope(1));
    expect(h.notices).toEqual([]);
    expect(terminals(h.frames)).toEqual([]);
  } finally {
    await h.runtime.stop();
  }
});

test("a Stop forgets a kept mention without a report; the hold does not outlive the process", async () => {
  const h = await failed();
  try {
    await h.deliver(1, h.envelope(1));
    await h.runtime.stopAgent("agent-a");
    expect(h.frames.filter((frame) => frame.kind !== "transition")).toEqual([]);

    // The next launch starts with no hold: the server's re-issue is told, not kept.
    await h.runtime.startAgent("agent-a", config);
    await h.deliver(1, h.envelope(1));
    await h.frameSent((frame) => frame.kind === "ack" || frame.kind === "terminal");
    expect(terminals(h.frames)).toEqual([]);
    expect(h.notices).toHaveLength(1);
  } finally {
    await h.runtime.stop();
  }
});

test("an inbox purge refuses a kept mention of the purged conversation once", async () => {
  const h = await failed();
  try {
    await h.deliver(1, h.envelope(1));
    h.runtime.handleAgentInboxPurge({
      protocolMajor: 1,
      requestId: "purge-1",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      conversationIds: ["conversation-a"],
      targets: ["#general"],
      reason: "member_removed",
    });
    await h.frameSent((frame) => frame.kind === "terminal");
    expect(terminals(h.frames)).toEqual([
      { kind: "terminal", deliveryId: "delivery-1", code: "DELIVERY_REJECTED" },
    ]);
  } finally {
    await h.runtime.stop();
  }
});

test("a pushed model the plan covers releases the hold: the live Agent is told what it kept", async () => {
  const h = await failed("Your plan does not include access to this model", { hasLiveTurn: false });
  try {
    await h.deliver(1, h.envelope(1));
    await h.deliver(2);
    await h.runtime.handleAgentConfig(push({ model: "another-model" }));
    await told(h, "delivery-1");
    h.emit({ type: "completed", status: "completed" });
    await h.frameSent((frame) => frame.kind === "ack" && frame.deliveryId === "delivery-1");

    expect(h.notices).toHaveLength(1);
    expect(terminals(h.frames)).toEqual([]);
    expect(h.restored).toMatchObject([
      { agentId: "agent-a", reason: "user_model_access", releaseCause: "model_changed" },
    ]);
  } finally {
    await h.runtime.stop();
  }
});

test("a person's Start lifts the hold: the live Agent is told what it kept", async () => {
  const h = await harness();
  try {
    // A managed launch, so a person's second Start rebinds the live process instead of spawning.
    await h.runtime.stopAgent("agent-a");
    await h.runtime.handleAgentStart(startIntent({ controlEpoch: 1, launchId: "launch-1" }));
    h.emit({ type: "error", message: AUTH });
    h.emit({ type: "completed", status: "failed" });
    await h.deliver(1, h.envelope(1));

    // Their act is the probe: the record ends and the mention it kept is handed over now,
    // instead of waiting for a turn that the hold itself prevents.
    await h.runtime.handleAgentStart(startIntent({ controlEpoch: 2, launchId: "launch-2" }));
    await told(h, "delivery-1");

    expect(h.restored).toMatchObject([
      { agentId: "agent-a", reason: "user_reauth", releaseCause: "explicit_start" },
    ]);
    expect(terminals(h.frames)).toEqual([]);
  } finally {
    await h.runtime.stop();
  }
});

test("a person's Start with no process running launches once and that launch tells what was kept", async () => {
  const h = await failed();
  try {
    await h.deliver(1, h.envelope(1));
    jest.useFakeTimers();
    h.exit();
    jest.useRealTimers();
    const launches = h.launches();

    // The Start itself is the launch: ending the hold here must not wake a second one.
    await h.runtime.handleAgentStart(startIntent({ launchId: "launch-start" }));
    await told(h, "delivery-1");

    expect(h.launches()).toBe(launches + 1);
    expect(h.restored).toMatchObject([
      { agentId: "agent-a", reason: "user_reauth", releaseCause: "explicit_start" },
    ]);
    expect(terminals(h.frames)).toEqual([]);
  } finally {
    jest.useRealTimers();
    await h.runtime.stop();
  }
});

test("a pushed configuration that leaves the credential invalid restarts the idle Agent and keeps it held", async () => {
  const h = await failed(AUTH, { hasLiveTurn: false });
  try {
    await h.deliver(1, h.envelope(1));
    await h.runtime.handleAgentConfig(push({ reasoning: "high" }));
    while (h.disposals() === 0) await Bun.sleep(5);

    // The restart is not run into the same failure: what is kept waits for the hour.
    await Bun.sleep(50);
    expect(h.launches()).toBe(1);
    expect(h.frames.filter((frame) => frame.kind !== "transition")).toEqual([]);
  } finally {
    await h.runtime.stop();
  }
});

const probe = (h: Awaited<ReturnType<typeof failed>>) =>
  h.runtime
    .handleAgentActivityProbe({
      protocolMajor: 1,
      requestId: "probe-request",
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      agentId: "agent-a",
      probeId: "probe-1",
    })
    .then(() => h.activities.filter((activity) => activity.probeId === "probe-1"));

test("an activity probe finds a held Agent's unread messages no reason to report it working", async () => {
  const held = await failed();
  const backedOff = await failed("connect ECONNRESET");
  try {
    for (const h of [held, backedOff]) await h.deliver(1);
    expect((await probe(backedOff)).map((each) => each.detailKind)).toContain("message_received");
    expect((await probe(held)).map((each) => each.detailKind)).not.toContain("message_received");
  } finally {
    await held.runtime.stop();
    await backedOff.runtime.stop();
  }
});

test("a launch that throws a credential failure holds the Agent as a mid-turn one does", async () => {
  const h = await failed(AUTH, { failLaunches: [2], launchError: AUTH });
  try {
    await h.deliver(1, h.envelope(1));
    jest.useFakeTimers();
    h.exit();
    jest.advanceTimersByTime(CLOSED_HOLD_MS);
    jest.useRealTimers();
    // The probe launch throws the same failure: the Agent shows it, stays held, and is not
    // taken offline, so what it kept waits for the next probe instead of being lost.
    while (h.launches() < 2) await Bun.sleep(5);
    await Bun.sleep(50);
    await h.deliver(2);
    expect(h.launches()).toBe(2);
    expect(terminals(h.frames)).toEqual([]);
    const shown = h.activities.findLast((each) => each.detailKind === "runtime_error")!;
    expect(shown.runtimeError?.requiredAction).toBe("user_reauth");
    jest.useFakeTimers();
    jest.advanceTimersByTime(CLOSED_HOLD_MS);
    jest.useRealTimers();
    while (h.launches() < 3) await Bun.sleep(5);
  } finally {
    jest.useRealTimers();
    await h.runtime.stop();
  }
});

test("a launch refused for its key keeps probing, and reaches the Agent once the key works", async () => {
  // A provider that refuses the credential in its own words and cannot report a typed error
  // (Pi-style, where the adapter reads no login state): the hold may not depend on the adapter
  // knowing, or a held message would wait for a probe nobody runs. The probe is the hold's own.
  const h = await failed(AUTH, { failLaunches: [2], launchError: AUTH, checkSequences: [1] });
  try {
    await h.deliver(1, h.envelope(1));
    jest.useFakeTimers();
    h.exit();
    jest.advanceTimersByTime(CLOSED_HOLD_MS);
    jest.useRealTimers();

    // The probe launch is refused in its own words too: still held, still nothing refused.
    while (h.launches() < 2) await Bun.sleep(5);
    await Bun.sleep(50);
    await h.deliver(2);
    expect(h.launches()).toBe(2);
    expect(h.notices).toEqual([]);
    expect(terminals(h.frames)).toEqual([]);

    // A person fixes the key: the next probe starts, what the hold kept is in that Session for
    // the Agent to read, and its check acknowledges it — so nothing waits on a hold nobody
    // probes, nor on a launch that took the mention and died before telling it.
    jest.useFakeTimers();
    jest.advanceTimersByTime(CLOSED_HOLD_MS);
    jest.useRealTimers();
    while (h.launches() < 3) await Bun.sleep(5);
    h.emit({ type: "completed", status: "completed" });
    await h.check();
    await h.frameSent((frame) => frame.kind === "ack" && frame.deliveryId === "delivery-1");
    expect(terminals(h.frames)).toEqual([]);
  } finally {
    jest.useRealTimers();
    await h.runtime.stop();
  }
});
