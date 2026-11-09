import { expect, test } from "bun:test";
import { AgentDeliveryQueue } from "#src/daemon-runtime/agent-delivery-queue";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { REMEMBERED_DELIVERIES } from "#src/daemon-runtime/agent-message-attention-index-helpers";
import { delivery, session } from "./fixtures/attention-delivery";

/** The attention index wired to a real `AgentDeliveryQueue` as `message-composition.ts` wires it,
 * with the Agent's deliveries held (a runtime-error backoff). */
function heldAgent() {
  const queue = new AgentDeliveryQueue();
  const notices: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async () => {},
    () => {},
    {
      shouldHold: (agentId) => queue.shouldHold(agentId),
      queued: (agentId) => queue.pending(agentId),
      enqueue: (agentId, message) => queue.enqueue(agentId, message),
      busy: (agentId) => queue.busy(agentId),
    },
  );
  queue.hold("agent-1", "rate_limit_backoff");
  return { queue, index, notices };
}

const message = (n: number) => ({ ...delivery(`m${n}`), sequence: n + 1 });
const HELD = REMEMBERED_DELIVERIES + 50;

test("flushing more held deliveries than the remembered window records each one's attention once", async () => {
  const { queue, index } = heldAgent();
  for (let n = 0; n < HELD; n += 1) await index.receive(message(n));
  expect(index.pendingMessageCount("agent-1", "@agent")).toBe(HELD);

  await index.flush("agent-1", queue.release("agent-1"));

  expect(index.pendingMessageCount("agent-1", "@agent")).toBe(HELD);
});

test("a resend that replaced a held delivery is not recorded again by the flush", async () => {
  const { queue, index } = heldAgent();
  for (let n = 0; n < 10; n += 1) await index.receive(message(n));
  // The resend of a remembered delivery takes the first one's place in the queue.
  await index.receive({ ...message(0), requestId: "request-resent" });
  // Then the window moves on and forgets the first ten deliveries.
  for (let n = 10; n < HELD; n += 1) await index.receive(message(n));
  expect(queue.pending("agent-1")).toHaveLength(HELD);

  await index.flush("agent-1", queue.release("agent-1"));

  expect(index.pendingMessageCount("agent-1", "@agent")).toBe(HELD);
});

test("held deliveries the index never received are recorded by the flush", async () => {
  const { queue, index } = heldAgent();
  for (let n = 0; n < HELD; n += 1) queue.enqueue("agent-1", message(n));
  expect(index.pendingMessageCount("agent-1", "@agent")).toBe(0);

  await index.flush("agent-1", queue.release("agent-1"));

  expect(index.pendingMessageCount("agent-1", "@agent")).toBe(HELD);
});

test("a flush marks as notified only the deliveries the window still remembers", async () => {
  const { queue, index, notices } = heldAgent();
  for (let n = 0; n < HELD; n += 1) await index.receive(message(n));
  await index.flush("agent-1", queue.release("agent-1"));
  expect(notices).toHaveLength(1);

  // The newest are still remembered, so a resend of one is already notified.
  expect(index.wasNotified(message(HELD - 1))).toBe(true);
  // The oldest left the window, and the notified set does not keep them past it.
  expect(index.wasNotified(message(0))).toBe(false);
});

test("a held delivery that survives its generation is recorded once by the next generation's flush", async () => {
  const { queue, index, notices } = heldAgent();
  await index.receive(message(0));
  // The process exits: the index forgets the Agent, the delivery queue keeps what it held.
  index.clearAgent("agent-1");
  expect(index.pendingMessageCount("agent-1", "@agent")).toBe(0);

  await index.flush("agent-1", queue.release("agent-1"));
  expect(index.pendingMessageCount("agent-1", "@agent")).toBe(1);
  expect(notices).toHaveLength(1);

  // A resend of it is already notified in this generation.
  await index.receive({ ...message(0), requestId: "request-resent" });
  expect(notices).toHaveLength(1);
});

test("a resend of a held delivery the window has forgotten does not record its attention again", async () => {
  const { queue, index } = heldAgent();
  for (let n = 0; n < HELD; n += 1) await index.receive(message(n));
  expect(index.pendingMessageCount("agent-1", "@agent")).toBe(HELD);

  await index.receive({ ...message(0), requestId: "request-resent" });

  expect(queue.pending("agent-1")).toHaveLength(HELD);
  expect(index.pendingMessageCount("agent-1", "@agent")).toBe(HELD);
});

test("Memory batches past the remembered window record each delivery's attention once", async () => {
  const timers: (() => Promise<void>)[] = [];
  const memorySession = session();
  let held = true;
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    {
      session: () => memorySession,
      runtime: () => ({
        session: memorySession,
        config: {
          provider: "coforge",
          model: "eval",
          reasoning: "",
          toolProfile: "openviking-memory",
        },
      }),
    },
    async () => {},
    () => {},
    { shouldHold: () => held, enqueue: () => {}, busy: () => {} },
    {
      schedule(callback) {
        timers.push(callback);
        return () => {};
      },
    },
  );
  for (let n = 0; n < HELD; n += 1)
    await index.receive({ ...message(n), target: "#team", mentionsAgent: false });
  expect(index.pendingMessageCount("agent-1", "#team")).toBe(HELD);

  held = false;
  await timers.at(-1)!();

  expect(index.pendingMessageCount("agent-1", "#team")).toBe(HELD);
  index.clearAgent("agent-1");
});

test("a notice accepted after its delivery left the remembered window does not mark it notified", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  const gated = {
    ...session(),
    notify: async () => {
      if (!first) return;
      first = false;
      await gate;
    },
  };
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => gated },
    async () => {},
  );
  const pending = index.receive(message(0));
  for (let n = 1; n < HELD; n += 1) await index.receive(message(n));

  release();
  await pending;

  expect(index.wasNotified(message(0))).toBe(false);
  expect(index.wasNotified(message(HELD - 1))).toBe(true);
});
