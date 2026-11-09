import { expect, test } from "bun:test";
import { classifyRuntimeError } from "#src/agent-runtime/runtime-error-classification";
import {
  RuntimeErrorDeliveryHold,
  type RuntimeErrorDeliveryHoldPorts,
} from "#src/daemon-runtime/runtime-error-delivery-hold";
import type { RuntimeErrorClassFence } from "#src/agent-runtime/runtime-error-recovery";
import { captureDaemonLogs } from "./log-capture";

/**
 * Raft keeps an Agent online through a provider it cannot reach, its own server error, and a rate
 * limit: those lift on their own, so the answer is to back off and try again, not to go offline
 * (task #726). The repeat fence still owns every other failure that does not take the Agent
 * offline by itself.
 */
type Launch = { runtimeErrorClassFence?: RuntimeErrorClassFence };

function harness() {
  const held = new Map<
    string,
    ReturnType<RuntimeErrorDeliveryHoldPorts["deliveryQueue"]["explicitHold"]>
  >();
  const hold = new RuntimeErrorDeliveryHold({
    deliveryQueue: {
      hold: (id, reason) => {
        held.set(id, reason);
      },
      release: (id) => {
        held.delete(id);
        return [];
      },
      endHoldForNextLaunch: (id) => void held.delete(id),
      explicitHold: (id) => held.get(id),
      pending: () => [],
    },
    flush() {
      throw new Error("a fenced Agent's deliveries must not be flushed");
    },
  });
  /** One failure in the same turn: nothing ends the turn or reports output in between. */
  const note = (message: string) => {
    const event = { type: "error", message } as const;
    return hold.noteRuntimeFailure("agent", {} as Launch, event, classifyRuntimeError(event));
  };
  return { hold, note, held };
}

test("the same provider connection failure three times in one turn holds deliveries and stays online", () => {
  const { hold, note, held } = harness();
  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(note("read ECONNRESET while contacting the provider").fence).toBeUndefined();
      // Backoff, not a fence: the Agent is still there and its delivery is merely waiting.
      expect(held.get("agent")).toBe("runtime_error_backoff");
    }
  } finally {
    hold.disposeAll();
  }
});

test("the same provider server error, rate limit and 5xx each three times in one turn stay online", () => {
  for (const message of [
    "HTTP 503: upstream service unavailable",
    "429 Too Many Requests",
    "Error sending request for url (https://api.example/v1/messages)",
  ]) {
    const { hold, note } = harness();
    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) expect(note(message).fence).toBeUndefined();
    } finally {
      hold.disposeAll();
    }
  }
});

test("a failure that is nobody's transient problem still fences after three identical repeats", () => {
  // The fence keeps its job: a runtime stuck on the same unexplained failure goes offline
  // rather than backing off forever (task #726 leaves this class alone).
  const { hold, note } = harness();
  try {
    expect(note("the provider returned a body this runtime cannot decode").fence).toBeUndefined();
    expect(note("the provider returned a body this runtime cannot decode").fence).toBeUndefined();
    expect(note("the provider returned a body this runtime cannot decode").fence).toMatchObject({
      attempts: 3,
      event: "agent_runtime:fingerprint_fence_tripped",
    });
  } finally {
    hold.disposeAll();
  }
});

test("a transient repeat never resets the fence streak of a real one beside it", () => {
  // The streak is "the same failure repeating", so an interleaved connection reset is invisible
  // to it: it neither adds to the unexplained failure's count nor launders the two before it.
  const { hold, note } = harness();
  try {
    const stuck = "the provider returned a body this runtime cannot decode";
    expect(note(stuck).fence).toBeUndefined();
    expect(note(stuck).fence).toBeUndefined();
    expect(note("read ECONNRESET while contacting the provider").fence).toBeUndefined();
    expect(note(stuck).fence).toMatchObject({
      attempts: 3,
      event: "agent_runtime:fingerprint_fence_tripped",
    });
  } finally {
    hold.disposeAll();
  }
});

/** The transient classes are exempt from the fence, so nothing but the log says how long a run of
 * retries lasted: one line per step, with the wait and the queue behind it, and no wording (task
 * #726, Raft's ruling on unbounded holding). */
test("every backoff step logs its rung, its wait and the queue depth, never the mail", async () => {
  const { records } = await captureDaemonLogs(async () => {
    const hold = new RuntimeErrorDeliveryHold({
      deliveryQueue: {
        hold: () => {},
        release: () => [],
        endHoldForNextLaunch: () => {},
        explicitHold: () => undefined,
        pending: () => [{ body: "the wording nobody may log" }, { body: "nor this" }] as never,
      },
      flush() {
        throw new Error("a retrying Agent's deliveries are held, not flushed");
      },
    });
    try {
      const event = { type: "error", message: "429 Too Many Requests" } as const;
      hold.noteRuntimeFailure("agent", {} as Launch, event, classifyRuntimeError(event));
      hold.noteRuntimeFailure("agent", {} as Launch, event, classifyRuntimeError(event));
    } finally {
      hold.disposeAll();
    }
  });
  const steps = records.filter(
    (record) => record.properties.event === "agent.runtime.delivery_held",
  );
  expect(steps).toHaveLength(2);
  expect(steps.map((step) => step.properties.attempt)).toEqual([1, 2]);
  expect(steps.at(-1)!.properties).toMatchObject({
    agent_id: "agent",
    error_class: "RateLimitError",
    held: 2,
    reason: "rate_limit_backoff",
    outcome: "held",
  });
  // The second rung waits longer than the first: the log shows the backoff growing.
  expect(Number(steps[1]!.properties.retry_in_ms)).toBeGreaterThan(
    Number(steps[0]!.properties.retry_in_ms),
  );
  expect(JSON.stringify(records)).not.toContain("wording");
});
