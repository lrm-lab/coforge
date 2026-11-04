import { expect, test } from "bun:test";

import {
  STALLED_RECOVERY_SILENCE_MS,
  shouldRecoverStalledRuntime,
} from "#src/daemon-runtime/stalled-recovery";

test("a notice the process accepted and never acted on for 15 minutes is recovered", () => {
  // raft's rule (task #318): the Agent's process took `inbox_notice`, then for the stall window
  // produced no message.checked, no operation and no provider output — three silences together,
  // not a busy turn's quiet spell. Any one of the three still fresh means the Agent is working.
  const noticedIdle = {
    turnBusy: false,
    liveTurn: false,
    silentForMs: STALLED_RECOVERY_SILENCE_MS,
    hasOpenToolCall: false,
    resumable: true,
    noticeAcceptedForMs: STALLED_RECOVERY_SILENCE_MS,
    lastAgentActionForMs: STALLED_RECOVERY_SILENCE_MS,
  };
  expect(shouldRecoverStalledRuntime(noticedIdle)).toBe(true);
  // Below the window, either clock is too fresh to judge.
  expect(
    shouldRecoverStalledRuntime({
      ...noticedIdle,
      noticeAcceptedForMs: STALLED_RECOVERY_SILENCE_MS - 1,
    }),
  ).toBe(false);
  expect(
    shouldRecoverStalledRuntime({
      ...noticedIdle,
      lastAgentActionForMs: STALLED_RECOVERY_SILENCE_MS - 1,
    }),
  ).toBe(false);
  // A checked read, an operation, or provider output inside the window means the Agent is
  // acting: never kill it for being quiet on the other two.
  expect(
    shouldRecoverStalledRuntime({ ...noticedIdle, lastAgentActionForMs: 0 }),
  ).toBe(false);
  // Nothing ever noticed is not this case.
  expect(
    shouldRecoverStalledRuntime({ ...noticedIdle, noticeAcceptedForMs: undefined }),
  ).toBe(false);
  expect(shouldRecoverStalledRuntime({ ...noticedIdle, resumable: false })).toBe(false);
  expect(shouldRecoverStalledRuntime({ ...noticedIdle, hasOpenToolCall: true })).toBe(false);
});
