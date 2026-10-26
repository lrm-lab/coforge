import { expect, test } from "bun:test";
import { ToolCallLedger } from "#src/agent-runtime/tool-call-ledger";
import { ProviderProgress } from "#src/daemon-runtime/stalled-recovery";
import { turnInterruptCutoffAtMs } from "#src/daemon-runtime/turn-interrupt";

/** A process clock that only the test moves, standing in for the host's boot clock. */
function processClock(start: number) {
  let now = start;
  return { read: () => now, set: (value: number) => (now = value) };
}

test("the turn cutoff is the process-clock stamp taken when the turn began, not a later wall time", () => {
  const clock = processClock(1_000);
  const progress = new ProviderProgress(clock.read);
  clock.set(5_000);
  progress.noteTurnStarted();
  // Hours later the wall clock has slewed away from the process clock: the stamp is unaffected.
  const realNow = Date.now;
  Date.now = () => realNow() + 3 * 3_600_000;
  clock.set(9_000_000);
  try {
    expect(turnInterruptCutoffAtMs({ launchId: "l", progress })).toBe(5_000);
  } finally {
    Date.now = realNow;
  }
});

test("the cutoff is the older of the turn start and the oldest open tool call", () => {
  const clock = processClock(1_000);
  const progress = new ProviderProgress(clock.read);
  const toolCalls = new ToolCallLedger(undefined, undefined, clock.read);
  clock.set(2_000);
  toolCalls.observe({ type: "tool-start", id: "build", name: "bash", input: {} } as never);
  clock.set(3_000);
  progress.noteTurnStarted();
  clock.set(4_000);
  toolCalls.observe({ type: "tool-start", id: "test", name: "bash", input: {} } as never);
  expect(turnInterruptCutoffAtMs({ launchId: "l", progress, toolCalls })).toBe(2_000);
  expect(turnInterruptCutoffAtMs({ launchId: "l", toolCalls })).toBe(2_000);
  expect(turnInterruptCutoffAtMs({ launchId: "l" })).toBeUndefined();
});
