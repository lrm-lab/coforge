import { afterEach, expect, jest, test } from "bun:test";
import { RUNTIME_ERROR_CLASS } from "#src/agent-runtime/runtime-error-classification";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { RuntimeErrorDeliveryHold } from "#src/daemon-runtime/runtime-error-delivery-hold";

const HOUR_MS = 60 * 60_000;

afterEach(() => jest.useRealTimers());

/** A hold over a delivery queue that remembers who is held and why, and what a release gives back. */
function harness() {
  const held = new Map<string, string>();
  const queued = new Map<string, AgentMessageDelivery[]>();
  const flushed: Array<{ agentId: string; count: number }> = [];
  const cleared: string[] = [];
  const saved: Array<{ agentId: string; untilMs: number; reason: string }> = [];
  const hold = new RuntimeErrorDeliveryHold({
    deliveryQueue: {
      hold: (agentId, reason) => void held.set(agentId, reason),
      release: (agentId) => {
        held.delete(agentId);
        const deliveries = queued.get(agentId) ?? [];
        queued.delete(agentId);
        return deliveries;
      },
      explicitHold: (agentId) => held.get(agentId) as never,
      pending: (agentId) => queued.get(agentId) ?? [],
    },
    flush: (agentId, deliveries) => void flushed.push({ agentId, count: deliveries.length }),
    store: {
      save: (agentId, state) => void saved.push({ agentId, ...state }),
      clear: (agentId) => void cleared.push(agentId),
    },
  });
  const delivery = { deliveryId: "delivery-1" } as AgentMessageDelivery;
  return {
    hold,
    held,
    flushed,
    cleared,
    saved,
    queue: (agentId: string) => void queued.set(agentId, [delivery]),
  };
}

const rateLimit = {
  errorClass: RUNTIME_ERROR_CLASS.RATE_LIMIT,
  errorReason: "quota_exhausted",
  retryDecision: "retry",
  requiredAction: "none",
  takesAgentOffline: false,
} as never;

test("a rate-limit backoff ends at once: released, flushed, forgotten, and its timer gone", () => {
  jest.useFakeTimers();
  const { hold, held, flushed, cleared, queue } = harness();
  hold.restore([
    { agentId: "agent-a", untilMs: Date.now() + HOUR_MS, reason: "rate_limit_backoff" },
  ]);
  queue("agent-a");
  expect(held.get("agent-a")).toBe("rate_limit_backoff");

  expect(hold.releaseRateLimitBackoff("agent-a")).toBe(true);

  expect(held.has("agent-a")).toBe(false);
  expect(flushed).toEqual([{ agentId: "agent-a", count: 1 }]);
  expect(cleared).toEqual(["agent-a"]);
  // The wait it replaced does not end a second time when its hour is up.
  jest.advanceTimersByTime(HOUR_MS + 1);
  expect(flushed).toHaveLength(1);
  expect(cleared).toEqual(["agent-a"]);
});

test("a backoff the Daemon raised itself restarts from nothing after the release", () => {
  jest.useFakeTimers();
  const { hold, held, saved } = harness();
  hold.noteFailure("agent-a", rateLimit, "fingerprint-a");
  hold.noteFailure("agent-a", rateLimit, "fingerprint-a");
  const second = saved.at(-1)!;
  expect(second.untilMs - Date.now()).toBeGreaterThan(19_000);

  expect(hold.releaseRateLimitBackoff("agent-a")).toBe(true);
  expect(held.has("agent-a")).toBe(false);

  hold.noteFailure("agent-a", rateLimit, "fingerprint-a");
  expect(saved.at(-1)!.untilMs - Date.now()).toBeLessThanOrEqual(11_000);
});

test("a hold that is not a rate limit's stays where it is", () => {
  jest.useFakeTimers();
  const { hold, held, flushed, cleared } = harness();
  hold.restore([
    { agentId: "agent-a", untilMs: Date.now() + HOUR_MS, reason: "runtime_error_backoff" },
  ]);
  held.set("agent-b", "fingerprint_fence");

  expect(hold.releaseRateLimitBackoff("agent-a")).toBe(false);
  expect(hold.releaseRateLimitBackoff("agent-b")).toBe(false);
  expect(hold.releaseRateLimitBackoff("agent-without-a-hold")).toBe(false);

  expect(held.get("agent-a")).toBe("runtime_error_backoff");
  expect(held.get("agent-b")).toBe("fingerprint_fence");
  expect(flushed).toEqual([]);
  expect(cleared).toEqual([]);
});
