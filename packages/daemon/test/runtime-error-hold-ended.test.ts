import { afterEach, expect, jest, test } from "bun:test";
import { RUNTIME_ERROR_CLASS } from "#src/agent-runtime/runtime-error-classification";
import { RuntimeErrorDeliveryHold } from "#src/daemon-runtime/runtime-error-delivery-hold";

afterEach(() => jest.useRealTimers());

/** A hold that records each time a backoff ran its course, as the exited-Agent settlement hears it. */
function harness() {
  const held = new Map<string, string>();
  const ended: string[] = [];
  const hold = new RuntimeErrorDeliveryHold({
    deliveryGate: {
      hold: (agentId, reason) => void held.set(agentId, reason),
      release: (agentId) => (held.delete(agentId), []),
      endHoldForNextLaunch: (agentId) => void held.delete(agentId),
      explicitHold: (agentId) => held.get(agentId) as never,
      credentialHeld: (agentId) => held.get(agentId) === "credential_invalid",
      pending: () => [],
    },
    flush: () => {},
    backoffEnded: (agentId) => void ended.push(agentId),
  });
  return { hold, held, ended };
}

const rateLimit = {
  errorClass: RUNTIME_ERROR_CLASS.RATE_LIMIT,
  errorReason: "quota_exhausted",
  retryDecision: "retry",
  requiredAction: "none",
  takesAgentOffline: false,
} as never;

test("a backoff whose time is up tells who owns its Agent's kept mentions", () => {
  jest.useFakeTimers();
  const { hold, ended } = harness();
  hold.noteFailure("agent-a", rateLimit, "fingerprint-a", "codex");
  expect(ended).toEqual([]);

  jest.advanceTimersByTime(60 * 60_000);

  expect(ended).toEqual(["agent-a"]);
});

test("a lifted limit tells it too, for an Agent with a process and for one without", () => {
  jest.useFakeTimers();
  const { hold, ended } = harness();
  hold.noteFailure("agent-a", rateLimit, "fingerprint-a", "codex");
  hold.noteFailure("agent-b", rateLimit, "fingerprint-b", "codex");

  hold.releaseRateLimitBackoffs("codex", (agentId) => agentId === "agent-a");

  expect(ended.sort()).toEqual(["agent-a", "agent-b"]);
});

test("a Stop, an offline-taking failure and the Daemon stopping end the wait without telling it", () => {
  jest.useFakeTimers();
  const { hold, ended } = harness();
  hold.noteFailure("agent-a", rateLimit, "fingerprint-a", "codex");
  hold.noteFailure("agent-b", rateLimit, "fingerprint-b", "codex");

  hold.forget("agent-a");
  hold.disposeAll();
  jest.advanceTimersByTime(60 * 60_000);

  expect(ended).toEqual([]);
});
