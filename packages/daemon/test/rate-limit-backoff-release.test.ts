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
  const saved: Array<{ agentId: string; untilMs: number; reason: string; provider?: string }> = [];
  const hold = new RuntimeErrorDeliveryHold({
    deliveryGate: {
      hold: (agentId, reason) => void held.set(agentId, reason),
      release: (agentId) => {
        held.delete(agentId);
        const deliveries = queued.get(agentId) ?? [];
        queued.delete(agentId);
        return deliveries;
      },
      endHoldForNextLaunch: (agentId) => void held.delete(agentId),
      explicitHold: (agentId) => held.get(agentId) as never,
      credentialHeld: (agentId) => held.get(agentId) === "credential_invalid",
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
    queued,
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

const serverError = {
  errorClass: RUNTIME_ERROR_CLASS.RUNTIME,
  errorReason: "runtime_failure",
  retryDecision: "retry",
  requiredAction: "none",
  takesAgentOffline: false,
} as never;

const withSession = () => true;

test("a lifted limit ends the provider's rate-limit backoffs: released, flushed, forgotten, timer gone", () => {
  jest.useFakeTimers();
  const { hold, held, flushed, cleared, queue } = harness();
  hold.noteFailure("agent-a", rateLimit, "fingerprint-a", "codex");
  queue("agent-a");
  expect(held.get("agent-a")).toBe("rate_limit_backoff");

  expect(hold.releaseRateLimitBackoffs("codex", withSession)).toBe(1);

  expect(held.has("agent-a")).toBe(false);
  expect(flushed).toEqual([{ agentId: "agent-a", count: 1 }]);
  expect(cleared).toEqual(["agent-a"]);
  // The wait it replaced does not end a second time when its time is up.
  jest.advanceTimersByTime(HOUR_MS + 1);
  expect(flushed).toHaveLength(1);
  expect(cleared).toEqual(["agent-a"]);
});

test("an Agent without a session stops waiting but keeps its queue for the next launch", () => {
  jest.useFakeTimers();
  const { hold, held, flushed, cleared, queue, queued } = harness();
  hold.noteFailure("agent-a", rateLimit, "fingerprint-a", "codex");
  queue("agent-a");

  expect(hold.releaseRateLimitBackoffs("codex", () => false)).toBe(1);

  expect(held.has("agent-a")).toBe(false);
  expect(queued.get("agent-a")).toHaveLength(1);
  expect(flushed).toEqual([]);
  expect(cleared).toEqual(["agent-a"]);
});

test("a backoff the Daemon raised itself restarts from nothing after the release", () => {
  jest.useFakeTimers();
  const { hold, held, saved } = harness();
  hold.noteFailure("agent-a", rateLimit, "fingerprint-a", "codex");
  hold.noteFailure("agent-a", rateLimit, "fingerprint-a", "codex");
  const second = saved.at(-1)!;
  expect(second.untilMs - Date.now()).toBeGreaterThan(19_000);

  expect(hold.releaseRateLimitBackoffs("codex", withSession)).toBe(1);
  expect(held.has("agent-a")).toBe(false);

  hold.noteFailure("agent-a", rateLimit, "fingerprint-a", "codex");
  expect(saved.at(-1)!.untilMs - Date.now()).toBeLessThanOrEqual(11_000);
});

test("the provider is persisted with the backoff it raised", () => {
  jest.useFakeTimers();
  const { hold, saved } = harness();
  hold.noteFailure("agent-a", rateLimit, "fingerprint-a", "codex");
  hold.noteFailure("agent-b", rateLimit, "fingerprint-b");

  expect(saved[0]).toMatchObject({ agentId: "agent-a", provider: "codex" });
  expect(saved[1]).not.toHaveProperty("provider");
});

test("a failure observed on a launch records that launch's provider", () => {
  jest.useFakeTimers();
  const { hold, saved } = harness();
  const event = { type: "error", message: "You've hit your usage limit." } as const;

  hold.noteRuntimeFailure("agent-a", { provider: "codex" }, event, rateLimit);

  expect(saved).toEqual([
    {
      agentId: "agent-a",
      untilMs: expect.any(Number),
      reason: "rate_limit_backoff",
      provider: "codex",
    },
  ]);
  expect(hold.releaseRateLimitBackoffs("codex", withSession)).toBe(1);
});

test("a restored backoff is released by its recorded provider, with no relaunch needed", () => {
  jest.useFakeTimers();
  const { hold, held, flushed, cleared, queue } = harness();
  hold.restore([
    {
      agentId: "agent-a",
      untilMs: Date.now() + HOUR_MS,
      reason: "rate_limit_backoff",
      provider: "codex",
    },
  ]);
  queue("agent-a");

  expect(hold.releaseRateLimitBackoffs("codex", withSession)).toBe(1);

  expect(held.has("agent-a")).toBe(false);
  expect(flushed).toEqual([{ agentId: "agent-a", count: 1 }]);
  expect(cleared).toEqual(["agent-a"]);
  jest.advanceTimersByTime(HOUR_MS + 1);
  expect(flushed).toHaveLength(1);
});

test("a restored backoff that recorded no provider keeps waiting", () => {
  jest.useFakeTimers();
  const { hold, held, flushed, cleared } = harness();
  hold.restore([
    { agentId: "agent-a", untilMs: Date.now() + HOUR_MS, reason: "rate_limit_backoff" },
  ]);

  expect(hold.releaseRateLimitBackoffs("codex", withSession)).toBe(0);

  expect(held.get("agent-a")).toBe("rate_limit_backoff");
  expect(flushed).toEqual([]);
  expect(cleared).toEqual([]);
});

test("another provider's backoff, a backoff for another failure and a fence's hold stay", () => {
  jest.useFakeTimers();
  const { hold, held, flushed, cleared } = harness();
  hold.noteFailure("claude-agent", rateLimit, "fingerprint-c", "claude-code");
  hold.noteFailure("error-agent", serverError, "fingerprint-e", "codex");
  held.set("fenced-agent", "fingerprint_fence");

  expect(hold.releaseRateLimitBackoffs("codex", withSession)).toBe(0);

  expect(held.get("claude-agent")).toBe("rate_limit_backoff");
  expect(held.get("error-agent")).toBe("runtime_error_backoff");
  expect(held.get("fenced-agent")).toBe("fingerprint_fence");
  expect(flushed).toEqual([]);
  expect(cleared).toEqual([]);
});

test("a backoff that already ended on its own is not released again", () => {
  jest.useFakeTimers();
  const { hold, flushed } = harness();
  hold.noteFailure("agent-a", rateLimit, "fingerprint-a", "codex");
  jest.advanceTimersByTime(HOUR_MS);

  expect(hold.releaseRateLimitBackoffs("codex", withSession)).toBe(0);
  expect(flushed).toEqual([]);
});
