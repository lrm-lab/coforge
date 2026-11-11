import { afterEach, expect, setSystemTime, test } from "bun:test";
import {
  ProviderProgress,
  STALLED_RECOVERY_SILENCE_MS,
  STALLED_RECOVERY_SILENCE_QUEUE_ONLY_MS,
  shouldRecoverStalledRuntime,
} from "#src/daemon-runtime/stalled-recovery";

const START = new Date("2026-10-15T00:00:00.000Z");
const minutes = (count: number) => new Date(START.getTime() + count * 60_000);

afterEach(() => setSystemTime());

test("a busy turn with no provider event for 15 minutes, no open tool call and a resumable session is recovered", () => {
  const stalled = {
    turnBusy: true,
    liveTurn: true,
    silentForMs: STALLED_RECOVERY_SILENCE_MS,
    hasOpenToolCall: false,
    resumable: true,
    steersBusyTurn: true,
  };
  expect(STALLED_RECOVERY_SILENCE_MS).toBe(15 * 60_000);
  expect(shouldRecoverStalledRuntime(stalled)).toBe(true);
  expect(
    shouldRecoverStalledRuntime({ ...stalled, silentForMs: STALLED_RECOVERY_SILENCE_MS - 1 }),
  ).toBe(false);
  // A live turn the delivery path does not see as busy is still a turn to wait on.
  expect(shouldRecoverStalledRuntime({ ...stalled, turnBusy: false })).toBe(false);
  // A long build or test run is silent until it ends; it is never killed for a message.
  expect(shouldRecoverStalledRuntime({ ...stalled, hasOpenToolCall: true })).toBe(false);
  // A restart that cannot resume the session would start the conversation over.
  expect(shouldRecoverStalledRuntime({ ...stalled, resumable: false })).toBe(false);
});

test("a queue-only provider's silent busy turn waits out the hour before it is recovered", () => {
  // Raft's NON_STDIN_ALIVE_RECOVERY_MS: a provider with no mid-turn input cannot be handed the
  // waiting message anyway, so its quiet turn is weaker evidence of a hang.
  const stalled = {
    turnBusy: true,
    liveTurn: true,
    silentForMs: STALLED_RECOVERY_SILENCE_MS,
    hasOpenToolCall: false,
    resumable: true,
    steersBusyTurn: false,
  };
  expect(STALLED_RECOVERY_SILENCE_QUEUE_ONLY_MS).toBe(60 * 60_000);
  expect(shouldRecoverStalledRuntime(stalled)).toBe(false);
  expect(
    shouldRecoverStalledRuntime({
      ...stalled,
      silentForMs: STALLED_RECOVERY_SILENCE_QUEUE_ONLY_MS - 1,
    }),
  ).toBe(false);
  expect(
    shouldRecoverStalledRuntime({
      ...stalled,
      silentForMs: STALLED_RECOVERY_SILENCE_QUEUE_ONLY_MS,
    }),
  ).toBe(true);
  // The other two judgments are about waiting work, not provider silence: they keep the 15-minute
  // fuse for every provider.
  expect(
    shouldRecoverStalledRuntime({
      ...stalled,
      turnBusy: false,
      liveTurn: false,
      queuedForMs: STALLED_RECOVERY_SILENCE_MS,
    }),
  ).toBe(true);
});

test("a delivery queued for 15 minutes whose turn never began is recovered by the same judgment", () => {
  const waiting = {
    turnBusy: false,
    liveTurn: false,
    silentForMs: STALLED_RECOVERY_SILENCE_MS,
    queuedForMs: STALLED_RECOVERY_SILENCE_MS,
    hasOpenToolCall: false,
    resumable: true,
    steersBusyTurn: true,
  };
  expect(shouldRecoverStalledRuntime(waiting)).toBe(true);
  expect(
    shouldRecoverStalledRuntime({ ...waiting, queuedForMs: STALLED_RECOVERY_SILENCE_MS - 1 }),
  ).toBe(false);
  // An idle provider that just received its first message is not stalled, however long it was
  // quiet before that message.
  expect(shouldRecoverStalledRuntime({ ...waiting, queuedForMs: 0 })).toBe(false);
  expect(shouldRecoverStalledRuntime({ ...waiting, queuedForMs: undefined })).toBe(false);
  expect(shouldRecoverStalledRuntime({ ...waiting, resumable: false })).toBe(false);
  expect(shouldRecoverStalledRuntime({ ...waiting, hasOpenToolCall: true })).toBe(false);
});

// Open tool calls are the launch's `ToolCallLedger` (tool-call-ledger.test.ts).
test("provider progress counts every provider event", () => {
  setSystemTime(START);
  const progress = new ProviderProgress();
  setSystemTime(minutes(10));
  expect(progress.silentForMs()).toBe(10 * 60_000);
  progress.observe();
  expect(progress.silentForMs()).toBe(0);
});

test("work stops counting at the turn's own bookkeeping, which is not progress", () => {
  setSystemTime(START);
  const progress = new ProviderProgress();
  setSystemTime(minutes(10));
  progress.observe({ type: "context-usage" });
  // The turn's clock keeps counting from its last work; the launch's own liveness does not.
  expect(progress.lastEventAtMs).toBe(minutes(10).getTime());
  expect(progress.lastWorkAtMs).toBe(START.getTime());
  progress.observe({ type: "thinking-delta" });
  expect(progress.lastWorkAtMs).toBe(minutes(10).getTime());
});
