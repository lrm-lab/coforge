import { expect, test } from "bun:test";

import {
  STALLED_RECOVERY_SILENCE_MS,
  shouldRecoverStalledRuntime,
} from "#src/daemon-runtime/stalled-recovery";

test("a notice the process accepted and never acted on for 15 minutes is recovered", () => {
  // raft's rule (task #318): the Agent's process took `inbox_notice`, then for the stall window
  // produced no message.checked, no operation and no provider output — three silences together,
  // not a busy turn's quiet spell. Any one of the three still fresh means the Agent is working.
  // The last action is older than the notice: nothing happened after taking it.
  const noticedIdle = {
    turnBusy: false,
    liveTurn: false,
    silentForMs: STALLED_RECOVERY_SILENCE_MS,
    hasOpenToolCall: false,
    resumable: true,
    steersBusyTurn: true,
    noticeAcceptedForMs: STALLED_RECOVERY_SILENCE_MS,
    lastAgentActionForMs: STALLED_RECOVERY_SILENCE_MS + 60_000,
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
  expect(shouldRecoverStalledRuntime({ ...noticedIdle, lastAgentActionForMs: 0 })).toBe(false);
  // An Agent that acted *after* taking the notice answered it; being idle since is not frozen.
  expect(
    shouldRecoverStalledRuntime({
      ...noticedIdle,
      lastAgentActionForMs: STALLED_RECOVERY_SILENCE_MS - 60_000,
    }),
  ).toBe(false);
  // An Agent held for a provider limit or another retryable failure is waiting on purpose: a
  // restart cannot shorten that wait (Raft's providerLimitBackoffDelayMs).
  expect(shouldRecoverStalledRuntime({ ...noticedIdle, recoveryHold: true })).toBe(false);
  // The hold never silences a turn that is actually running: that one is judged on its own
  // silence, and a genuinely hung turn stays recoverable.
  expect(
    shouldRecoverStalledRuntime({
      turnBusy: true,
      liveTurn: true,
      silentForMs: STALLED_RECOVERY_SILENCE_MS,
      hasOpenToolCall: false,
      resumable: true,
      steersBusyTurn: true,
      recoveryHold: true,
    }),
  ).toBe(true);
  // Nothing ever noticed is not this case.
  expect(shouldRecoverStalledRuntime({ ...noticedIdle, noticeAcceptedForMs: undefined })).toBe(
    false,
  );
  expect(shouldRecoverStalledRuntime({ ...noticedIdle, resumable: false })).toBe(false);
  expect(shouldRecoverStalledRuntime({ ...noticedIdle, hasOpenToolCall: true })).toBe(false);
});

test("a notice steered into a turn already running is left to the delivery layer, not a restart", () => {
  // A notice's own write starts an idle Agent's turn (Raft commits the Agent to "turn in progress"
  // before writing), so the two times separate the two ways a notice can arrive: this one started
  // its turn, that one was steered into a turn that was already going (task #14, grace's case).
  const noticedIdle = {
    turnBusy: false,
    liveTurn: false,
    silentForMs: STALLED_RECOVERY_SILENCE_MS,
    hasOpenToolCall: false,
    resumable: true,
    steersBusyTurn: true,
    noticeAcceptedForMs: STALLED_RECOVERY_SILENCE_MS,
    lastAgentActionForMs: STALLED_RECOVERY_SILENCE_MS + 60_000,
    noticeAcceptedAtMs: 1_000_000,
  };
  // The notice's write started the turn: the wake never got going, which is a frozen Agent.
  expect(shouldRecoverStalledRuntime({ ...noticedIdle, turnStartedAtMs: 1_000_000 })).toBe(true);
  // No turn was ever recorded in this launch: nothing to say the wake started one, so the same
  // judgment as before applies.
  expect(shouldRecoverStalledRuntime({ ...noticedIdle, turnStartedAtMs: undefined })).toBe(true);
  // The notice went into a turn that had already started: that turn ending without a read is
  // what the delivery layer retries, and killing the runtime would end work it may be finishing.
  expect(shouldRecoverStalledRuntime({ ...noticedIdle, turnStartedAtMs: 999_000 })).toBe(false);
});
