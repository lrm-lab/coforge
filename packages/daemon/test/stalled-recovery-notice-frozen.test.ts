import { expect, test } from "bun:test";

import {
  STALLED_RECOVERY_SILENCE_MS,
  shouldRecoverStalledRuntime,
  stalledRecoveryBasis,
} from "#src/daemon-runtime/stalled-recovery";

test("a notice the process took and never acted on is recovered only while a turn is in progress", () => {
  // Raft's rule (task #318, tightened by #14): the Agent took a notice and produced no read, no
  // operation and no output for the stall window — but only a turn still in progress can be
  // frozen. A turn that ended leaves the Agent committed to idle, where being quiet after taking
  // a notice is its own choice (Raft's `stalledWithWork` requires `turnInProgress`).
  const frozenTurn = {
    turnBusy: false,
    liveTurn: true,
    silentForMs: STALLED_RECOVERY_SILENCE_MS,
    hasOpenToolCall: false,
    resumable: true,
    steersBusyTurn: true,
    noticeAcceptedForMs: STALLED_RECOVERY_SILENCE_MS,
    lastAgentActionForMs: STALLED_RECOVERY_SILENCE_MS + 60_000,
  };
  expect(stalledRecoveryBasis(frozenTurn, { lastEventAtMs: 0 })).toMatchObject({
    reason: "noticed_but_frozen",
  });
  // Below the window, either clock is too fresh to judge.
  expect(
    shouldRecoverStalledRuntime({
      ...frozenTurn,
      noticeAcceptedForMs: STALLED_RECOVERY_SILENCE_MS - 1,
    }),
  ).toBe(false);
  expect(
    shouldRecoverStalledRuntime({
      ...frozenTurn,
      lastAgentActionForMs: STALLED_RECOVERY_SILENCE_MS - 1,
    }),
  ).toBe(false);
  // A checked read, an operation, or provider output inside the window means the Agent is
  // acting: never kill it for being quiet on the other two.
  expect(shouldRecoverStalledRuntime({ ...frozenTurn, lastAgentActionForMs: 0 })).toBe(false);
  // An Agent that acted *after* taking the notice answered it; being idle since is not frozen.
  expect(
    shouldRecoverStalledRuntime({
      ...frozenTurn,
      lastAgentActionForMs: STALLED_RECOVERY_SILENCE_MS - 60_000,
    }),
  ).toBe(false);
  // An Agent held for a provider limit or another retryable failure is waiting on purpose: a
  // restart cannot shorten that wait (Raft's providerLimitBackoffDelayMs).
  expect(shouldRecoverStalledRuntime({ ...frozenTurn, recoveryHold: true })).toBe(false);
  // No turn in progress: the Agent finished working and chose not to read yet. Restarting it
  // tells it nothing new and starts a turn nobody asked for (task #14, grace sat idle for 15
  // minutes after a notice written as her turn ended and was restarted for it).
  expect(shouldRecoverStalledRuntime({ ...frozenTurn, liveTurn: false })).toBe(false);
  // A busy turn with an old notice is the turn's own silence, judged by `silent_turn`.
  expect(
    stalledRecoveryBasis(
      { ...frozenTurn, turnBusy: true, silentForMs: STALLED_RECOVERY_SILENCE_MS },
      { lastEventAtMs: 0 },
    ),
  ).toMatchObject({ reason: "silent_turn" });
  // Nothing ever noticed is not this case.
  expect(shouldRecoverStalledRuntime({ ...frozenTurn, noticeAcceptedForMs: undefined })).toBe(
    false,
  );
  expect(shouldRecoverStalledRuntime({ ...frozenTurn, resumable: false })).toBe(false);
  expect(shouldRecoverStalledRuntime({ ...frozenTurn, hasOpenToolCall: true })).toBe(false);
});
