import { expect, test } from "bun:test";
import { RUNTIME_ERROR_CLASS } from "#src/agent-runtime/runtime-error-classification";
import {
  RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS,
  RUNTIME_ERROR_DELIVERY_BACKOFF_MAX_MS,
  RUNTIME_ERROR_DELIVERY_BACKOFF_JITTER_RATIO,
  RUNTIME_ERROR_FINGERPRINT_FENCE_THRESHOLD,
  runtimeErrorDeliveryBackoffDelayMs,
  RuntimeErrorDeliveryBackoff,
  RuntimeErrorFingerprintFence,
  runtimeErrorRecoverySignal,
} from "#src/agent-runtime/runtime-error-recovery";

test("the first backoff delay is the base delay, with no jitter added when the random source returns 0", () => {
  const delay = runtimeErrorDeliveryBackoffDelayMs(1, { jitterRandom: () => 0 });
  expect(delay).toBe(RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS);
});

test("the delay doubles with each attempt", () => {
  expect(runtimeErrorDeliveryBackoffDelayMs(2, { jitterRandom: () => 0 })).toBe(
    RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS * 2,
  );
  expect(runtimeErrorDeliveryBackoffDelayMs(3, { jitterRandom: () => 0 })).toBe(
    RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS * 4,
  );
});

test("the delay is capped at the maximum even for a very high attempt count", () => {
  const delay = runtimeErrorDeliveryBackoffDelayMs(20, { jitterRandom: () => 0 });
  expect(delay).toBe(RUNTIME_ERROR_DELIVERY_BACKOFF_MAX_MS);
});

test("jitter adds up to the configured ratio of the capped delay, from an injectable source", () => {
  const withFullJitter = runtimeErrorDeliveryBackoffDelayMs(1, { jitterRandom: () => 1 });
  expect(withFullJitter).toBe(
    Math.floor(
      RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS * (1 + RUNTIME_ERROR_DELIVERY_BACKOFF_JITTER_RATIO),
    ),
  );
  const withHalfJitter = runtimeErrorDeliveryBackoffDelayMs(1, { jitterRandom: () => 0.5 });
  expect(withHalfJitter).toBeGreaterThan(RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS);
  expect(withHalfJitter).toBeLessThan(withFullJitter);
});

test("jitter never pushes the delay above the configured maximum", () => {
  const delay = runtimeErrorDeliveryBackoffDelayMs(20, { jitterRandom: () => 1 });
  expect(delay).toBe(RUNTIME_ERROR_DELIVERY_BACKOFF_MAX_MS);
});

test("RuntimeErrorDeliveryBackoff.recordFailure counts attempts and computes an increasing until-time", () => {
  const backoff = new RuntimeErrorDeliveryBackoff({ jitterRandom: () => 0 });
  const now = 1_000_000;
  const first = backoff.recordFailure("agent-1", RUNTIME_ERROR_CLASS.RUNTIME, now);
  expect(first.attempts).toBe(1);
  expect(first.delayMs).toBe(RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS);
  expect(first.untilMs).toBe(now + RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS);
  const second = backoff.recordFailure("agent-1", RUNTIME_ERROR_CLASS.RUNTIME, now);
  expect(second.attempts).toBe(2);
  expect(second.delayMs).toBe(RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS * 2);
});

test("RuntimeErrorDeliveryBackoff.reset clears the streak and reports how many failures were cleared", () => {
  const backoff = new RuntimeErrorDeliveryBackoff({ jitterRandom: () => 0 });
  backoff.recordFailure("agent-1", RUNTIME_ERROR_CLASS.RUNTIME);
  backoff.recordFailure("agent-1", RUNTIME_ERROR_CLASS.RUNTIME);
  expect(backoff.reset("agent-1")).toBe(2);
  expect(backoff.attempts("agent-1")).toBe(0);
  // A fresh failure after reset starts back at the base delay.
  const after = backoff.recordFailure("agent-1", RUNTIME_ERROR_CLASS.RUNTIME, 0);
  expect(after.attempts).toBe(1);
  expect(after.delayMs).toBe(RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS);
});

test("RuntimeErrorDeliveryBackoff tracks each Agent independently", () => {
  const backoff = new RuntimeErrorDeliveryBackoff({ jitterRandom: () => 0 });
  backoff.recordFailure("agent-1", RUNTIME_ERROR_CLASS.RUNTIME);
  backoff.recordFailure("agent-1", RUNTIME_ERROR_CLASS.RUNTIME);
  expect(backoff.attempts("agent-2")).toBe(0);
});

test("a fingerprint fence counts consecutive same-fingerprint failures and trips at the threshold", () => {
  const fence = new RuntimeErrorFingerprintFence();
  const first = fence.note("agent-1", "aaaaaaaa");
  expect(first).toEqual({ fingerprint: "aaaaaaaa", attempts: 1, fenced: false });
  const second = fence.note("agent-1", "aaaaaaaa");
  expect(second.attempts).toBe(2);
  expect(second.fenced).toBe(false);
  const third = fence.note("agent-1", "aaaaaaaa");
  expect(third.attempts).toBe(RUNTIME_ERROR_FINGERPRINT_FENCE_THRESHOLD);
  expect(third.fenced).toBe(true);
});

test("a different fingerprint restarts the streak instead of accumulating with the old one", () => {
  const fence = new RuntimeErrorFingerprintFence();
  fence.note("agent-1", "aaaaaaaa");
  fence.note("agent-1", "aaaaaaaa");
  const changed = fence.note("agent-1", "bbbbbbbb");
  expect(changed).toEqual({ fingerprint: "bbbbbbbb", attempts: 1, fenced: false });
});

test("fence.reset clears the streak for that Agent only", () => {
  const fence = new RuntimeErrorFingerprintFence();
  fence.note("agent-1", "aaaaaaaa");
  fence.note("agent-2", "cccccccc");
  fence.reset("agent-1");
  expect(fence.note("agent-1", "aaaaaaaa").attempts).toBe(1);
  expect(fence.note("agent-2", "cccccccc").attempts).toBe(2);
});

test("a retry-not-before time in the future is the whole delay, with no exponential or jitter", () => {
  const backoff = new RuntimeErrorDeliveryBackoff({ jitterRandom: () => 1 });
  const now = Date.parse("2026-10-21T13:00:00.000Z");
  const reset = "2026-10-21T16:00:00.000Z";
  const state = backoff.recordFailure("agent-1", RUNTIME_ERROR_CLASS.RATE_LIMIT, now, reset);
  expect(state).toEqual({ attempts: 1, delayMs: 3 * 60 * 60_000, untilMs: Date.parse(reset) });
});

test.each([
  ["already past", "2026-10-21T12:59:59.000Z"],
  ["unparseable", "4pm"],
])("a retry-not-before time %s falls back to the exponential delay", (_, notBefore) => {
  const backoff = new RuntimeErrorDeliveryBackoff({ jitterRandom: () => 0 });
  const now = Date.parse("2026-10-21T13:00:00.000Z");
  const state = backoff.recordFailure("agent-1", RUNTIME_ERROR_CLASS.RATE_LIMIT, now, notBefore);
  expect(state.delayMs).toBe(RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS);
});

test("model output from the main session is output; tool output and a subagent's are side output", () => {
  const subagent = { parentToolUseId: "toolu_1" };
  expect(runtimeErrorRecoverySignal({ type: "text-delta", text: "hi" })).toBe("output");
  expect(runtimeErrorRecoverySignal({ type: "thinking-delta", text: "hm" })).toBe("output");
  expect(runtimeErrorRecoverySignal({ type: "tool-start", id: "t", name: "Bash" })).toBe("output");
  expect(runtimeErrorRecoverySignal({ type: "text-delta", text: "hi", subagent })).toBe(
    "side_output",
  );
  expect(runtimeErrorRecoverySignal({ type: "tool-start", id: "t", name: "Bash", subagent })).toBe(
    "side_output",
  );
  expect(runtimeErrorRecoverySignal({ type: "tool-output", id: "t", text: "ok" })).toBe(
    "side_output",
  );
  expect(runtimeErrorRecoverySignal({ type: "progress" })).toBe("progress");
});
