import { expect, test } from "bun:test";
import {
  isNonRetryableLaunchFailure,
  LAUNCH_FAILURE_REASON,
  launchFailureActivity,
  launchFailureReason,
} from "#src/agent-runtime/launch-failure";
import { LaunchFailureBackoff } from "#src/agent-runtime/launch-failure-backoff";
import {
  AgentStartupDeadlineExceededError,
  STARTUP_DEADLINE_EXCEEDED_DETAIL,
} from "#src/agent-runtime/startup-deadline-failure";

/** What a slow runtime gets: twice its 600 s startup window plus a minute. */
const DEADLINE = 21 * 60_000;

test("the cause the wakes ended is named, so the report is not a guess", () => {
  const backoff = new LaunchFailureBackoff();
  expect(backoff.exhaustedBy("a", 7)).toBeUndefined();
  backoff.recordFailure("a", 0);
  // One failure, time and count both still have room.
  expect(backoff.exhaustedBy("a", 7, 1_000, DEADLINE)).toBeUndefined();
  expect(backoff.exhaustedBy("a", 7, DEADLINE, DEADLINE)).toBe("deadline");
  // The count cap keeps its own name even once the window has passed too: the attempts, not the
  // clock, are what ended it.
  expect(backoff.exhaustedBy("a", 1, DEADLINE, DEADLINE)).toBe("streak");
  backoff.recordFailure("b", 0, undefined, true);
  expect(backoff.exhaustedBy("b", 7, 0, DEADLINE)).toBe("terminal");
});

test("the deadline's failure carries the reason, the sentence, and the no-retry verdict", () => {
  const error = new AgentStartupDeadlineExceededError(3, DEADLINE, DEADLINE + 1);
  expect(launchFailureReason(error)).toBe(LAUNCH_FAILURE_REASON.STARTUP_DEADLINE_EXCEEDED);
  expect(launchFailureActivity(error, "Pi").detail).toBe(STARTUP_DEADLINE_EXCEEDED_DETAIL);
  expect(isNonRetryableLaunchFailure(error)).toBe(true);
});

test("a streak's clock starts at its first failure and never restarts on a later one", () => {
  const backoff = new LaunchFailureBackoff();
  const started = 1_000_000;
  backoff.recordFailure("a", started);
  backoff.recordFailure("a", started + 600_000);
  // Two attempts in: the second did not push the clock forward.
  expect(backoff.streakStart("a")).toBe(started);
  expect(backoff.exhaustedBy("a", 7, started + 600_000 + 1, DEADLINE)).toBeUndefined();
  expect(backoff.exhaustedBy("a", 7, started + DEADLINE, DEADLINE)).toBe("deadline");
});

test("a success clears the streak, so the next failure is not already overdue", () => {
  const backoff = new LaunchFailureBackoff();
  backoff.recordFailure("a", 0);
  expect(backoff.exhaustedBy("a", 7, DEADLINE, DEADLINE)).toBe("deadline");
  backoff.reset("a");
  expect(backoff.exhaustedBy("a", 7, DEADLINE, DEADLINE)).toBeUndefined();
  expect(backoff.streakStart("a")).toBeUndefined();
});

test("the window ends the attempts by time, not only by count", () => {
  const backoff = new LaunchFailureBackoff();
  backoff.recordFailure("a", 0);
  // Three slow attempts: the count cap has room, the window does not.
  expect(backoff.attempts("a")).toBe(1);
  expect(backoff.exhaustedBy("a", 7, DEADLINE - 1, DEADLINE)).toBeUndefined();
  expect(backoff.exhaustedBy("a", 7, DEADLINE, DEADLINE)).toBe("deadline");
  // Without a window it is the old behaviour: only the count decides.
  expect(backoff.exhaustedBy("a", 7, DEADLINE)).toBeUndefined();
});

test("fast failures still walk the whole ladder inside the window", () => {
  const backoff = new LaunchFailureBackoff();
  let now = 0;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    backoff.recordFailure("a", now);
    // A failure that returns in a second is nowhere near the window, so the count still has room.
    expect(backoff.exhaustedBy("a", 7, now + 1_000, DEADLINE)).toBeUndefined();
    now += 1_000;
  }
  backoff.recordFailure("a", now);
  expect(backoff.attempts("a")).toBe(7);
  // The seventh failure is the count cap's business, not the window's.
  expect(backoff.exhaustedBy("a", 7, now, DEADLINE)).toBe("streak");
});

test("a wait on a recovery time spends none of the window", () => {
  const backoff = new LaunchFailureBackoff();
  // A quota failure names its recovery three hours out: the wait is not the runtime's fault, so
  // the deadline has to start when the wait ends rather than at the failure.
  const WAIT = 3 * 60 * 60_000;
  backoff.recordFailure("a", 0, WAIT);
  expect(backoff.streakStart("a")).toBe(WAIT);
  expect(backoff.exhaustedBy("a", 7, WAIT - 1, DEADLINE)).toBeUndefined();
  // Still not used up a minute into the attempts that follow the wait...
  expect(backoff.exhaustedBy("a", 7, WAIT + 60_000, DEADLINE)).toBeUndefined();
  // ...and every failure after the wait measures from the same start, so the window still ends.
  backoff.recordFailure("a", WAIT + 60_000);
  expect(backoff.streakStart("a")).toBe(WAIT);
  expect(backoff.exhaustedBy("a", 7, WAIT + DEADLINE, DEADLINE)).toBe("deadline");
});
