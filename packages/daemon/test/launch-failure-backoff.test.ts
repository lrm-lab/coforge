import { expect, test } from "bun:test";
import {
  LAUNCH_FAILURE_BACKOFF_BASE_MS,
  LAUNCH_FAILURE_BACKOFF_CAP_MS,
  LaunchFailureBackoff,
  launchFailureCooldownMs,
} from "#src/agent-runtime/launch-failure-backoff";

test("the cooldown doubles from one second and caps at thirty", () => {
  expect([1, 2, 3, 4, 5, 6, 7, 8, 12].map((attempts) => launchFailureCooldownMs(attempts))).toEqual(
    [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000],
  );
});

test("the cooldown stays bounded for an absurd attempt count", () => {
  expect(launchFailureCooldownMs(Number.MAX_SAFE_INTEGER)).toBe(LAUNCH_FAILURE_BACKOFF_CAP_MS);
  expect(launchFailureCooldownMs(0)).toBe(LAUNCH_FAILURE_BACKOFF_BASE_MS);
});

test("consecutive failures count and the cooldown is measured from each failure", () => {
  const backoff = new LaunchFailureBackoff();
  expect(backoff.recordFailure("a", 10_000)).toEqual({
    attempts: 1,
    cooldownMs: 1_000,
    untilMs: 11_000,
  });
  expect(backoff.attempts("a")).toBe(1);
  expect(backoff.isBlocked("a", 10_500)).toBe(true);
  expect(backoff.isBlocked("a", 11_000)).toBe(false);

  expect(backoff.recordFailure("a", 11_000)).toEqual({
    attempts: 2,
    cooldownMs: 2_000,
    untilMs: 13_000,
  });
  expect(backoff.blockedUntil("a")).toBe(13_000);
});

test("agents fail independently and a reset only clears its own streak", () => {
  const backoff = new LaunchFailureBackoff();
  backoff.recordFailure("a");
  backoff.recordFailure("b");
  backoff.recordFailure("b");

  expect(backoff.reset("b")).toBe(2);
  expect(backoff.attempts("b")).toBe(0);
  expect(backoff.isBlocked("b")).toBe(false);
  expect(backoff.reset("b")).toBe(0);
  expect(backoff.attempts("a")).toBe(1);
});

test("an explicit cooldown replaces the exponential one and still counts the attempt", () => {
  const backoff = new LaunchFailureBackoff();
  const threeHours = 3 * 60 * 60 * 1000;
  expect(backoff.recordFailure("a", 10_000, threeHours)).toEqual({
    attempts: 1,
    cooldownMs: threeHours,
    untilMs: 10_000 + threeHours,
  });
  expect(backoff.isBlocked("a", 10_000 + threeHours - 1)).toBe(true);
  expect(backoff.isBlocked("a", 10_000 + threeHours)).toBe(false);
  expect(backoff.recordFailure("a", 20_000, threeHours).cooldownMs).toBe(threeHours);
  expect(backoff.attempts("a")).toBe(2);
  expect(backoff.recordFailure("a", 30_000).cooldownMs).toBe(4_000);
});

test("a non-positive explicit cooldown keeps the exponential backoff", () => {
  const backoff = new LaunchFailureBackoff();
  expect(backoff.recordFailure("a", 10_000, 0).cooldownMs).toBe(1_000);
  expect(backoff.recordFailure("b", 10_000, Number.NaN).cooldownMs).toBe(1_000);
});

test("clear forgets every agent", () => {
  const backoff = new LaunchFailureBackoff();
  backoff.recordFailure("a");
  backoff.recordFailure("b");
  backoff.clear();
  expect([backoff.attempts("a"), backoff.attempts("b")]).toEqual([0, 0]);
});
