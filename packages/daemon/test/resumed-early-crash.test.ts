import { expect, test } from "bun:test";
import {
  isResumedEarlyCrashClose,
  RESUMED_EARLY_CRASH_FALLBACK_THRESHOLD,
  RESUMED_EARLY_CRASH_WINDOW_MS,
  ResumedEarlyCrashStreak,
  type ResumedEarlyCrashFacts,
} from "#src/daemon-runtime/resumed-early-crash";

function facts(overrides: Partial<ResumedEarlyCrashFacts> = {}): ResumedEarlyCrashFacts {
  return {
    resumedSessionId: "sess-1",
    sessionModeCreate: false,
    uptimeMs: 2_000,
    modelOutputObserved: false,
    offline: false,
    deliveryHold: false,
    daemonStopping: false,
    ...overrides,
  };
}

test("a resumed session that dies silently inside the window qualifies", () => {
  expect(isResumedEarlyCrashClose(facts())).toBe(true);
  expect(isResumedEarlyCrashClose(facts({ uptimeMs: RESUMED_EARLY_CRASH_WINDOW_MS }))).toBe(true);
});

test("each non-qualifying close fact excludes the exit", () => {
  expect(isResumedEarlyCrashClose(facts({ resumedSessionId: undefined }))).toBe(false);
  expect(isResumedEarlyCrashClose(facts({ sessionModeCreate: true }))).toBe(false);
  expect(isResumedEarlyCrashClose(facts({ uptimeMs: RESUMED_EARLY_CRASH_WINDOW_MS + 1 }))).toBe(
    false,
  );
  expect(isResumedEarlyCrashClose(facts({ modelOutputObserved: true }))).toBe(false);
  expect(isResumedEarlyCrashClose(facts({ offline: true }))).toBe(false);
  expect(isResumedEarlyCrashClose(facts({ deliveryHold: true }))).toBe(false);
  expect(isResumedEarlyCrashClose(facts({ daemonStopping: true }))).toBe(false);
});

test("the streak counts consecutive closes of one session and resets on another", () => {
  const streak = new ResumedEarlyCrashStreak();
  expect(streak.note("agent-a", "sess-1")).toBe(1);
  expect(streak.note("agent-a", "sess-1")).toBe(RESUMED_EARLY_CRASH_FALLBACK_THRESHOLD);
  expect(streak.note("agent-a", "sess-2")).toBe(1);
  expect(streak.note("agent-a", "sess-1")).toBe(1);
  expect(streak.note("agent-b", "sess-1")).toBe(1);
});

test("a non-qualifying close or a cold start clears the streak", () => {
  const streak = new ResumedEarlyCrashStreak();
  streak.note("agent-a", "sess-1");
  streak.clear("agent-a");
  expect(streak.note("agent-a", "sess-1")).toBe(1);
  streak.note("agent-a", "sess-1");
  streak.clear("agent-a");
  expect(streak.note("agent-a", "sess-1")).toBe(1);
});
