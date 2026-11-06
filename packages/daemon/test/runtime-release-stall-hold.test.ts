import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { AgentSession } from "@lrm/coforge-anvil";
import type { AgentRestartConfig } from "#src/agent-runtime/agent-process-manager";
import { RuntimeRelease, type RuntimeReleasePorts } from "#src/daemon-runtime/runtime-release";
import {
  STALLED_RECOVERY_SILENCE_MS,
  STALLED_RECOVERY_SILENCE_QUEUE_ONLY_MS,
  ProviderProgress,
} from "#src/daemon-runtime/stalled-recovery";
import type { DeliveryHoldReason } from "#src/daemon-runtime/agent-delivery-queue";

type Launch = { stopping: boolean; progress?: ProviderProgress };

const START = new Date("2026-11-06T00:00:00.000Z");

afterEach(() => setSystemTime());

/** A queued delivery whose turn never began, with no live turn: the stall branch that fires for
 * an idle runtime, and the one a provider-limit hold must keep from restarting. */
function subject(
  hold: DeliveryHoldReason | undefined,
  options: {
    provider?: RuntimeProvider;
    busyTurn?: boolean;
    steersBusyTurn?: boolean;
  } = {},
) {
  setSystemTime(START);
  const launch: Launch = { stopping: false, progress: new ProviderProgress() };
  const session = {
    hasLiveTurn: options.busyTurn === true,
    steersBusyTurn: options.steersBusyTurn,
  } as unknown as AgentSession;
  const restart: AgentRestartConfig = {
    config: {
      provider: options.provider ?? "pi",
      model: "m",
      modelProvider: "anthropic",
      reasoning: "balanced",
    },
    sessionId: "native-1",
  };
  const ports: RuntimeReleasePorts<Launch> = {
    launch: () => launch,
    runtime: () => ({ session }) as never,
    restartConfig: () => restart,
    lastBusy: () =>
      options.busyTurn === true
        ? ({ launch, activity: { detail: "working" }, at: START.getTime() } as never)
        : undefined,
    queuedForMs: () => STALLED_RECOVERY_SILENCE_MS + 60_000,
    explicitHold: () => hold,
    resumable: () => true,
    sessionId: () => "native-1",
    isStopping: () => false,
    daemonIdleFacts: () => ({}) as never,
    hasParkedWork: () => true,
    flushParked: () => {},
    wake: async () => {},
    publish: () => {},
    handBackMentions: async () => {},
    release: async () => {},
  };
  return {
    release: new RuntimeRelease(ports),
    advance: (ms: number) => setSystemTime(new Date(Date.now() + ms)),
  };
}

test("a delivery held for a provider limit waits for the reset instead of a restart", () => {
  expect(subject("rate_limit_backoff").release.stalled("agent-a")).toBeUndefined();
});

test("a delivery held for another retryable failure waits out its delay too", () => {
  expect(subject("runtime_error_backoff").release.stalled("agent-a")).toBeUndefined();
});

test("without a hold, the same queued delivery is still a stall", () => {
  expect(subject(undefined).release.stalled("agent-a")).toBeDefined();
});

test("a fingerprint fence does not silence the judgment: that hold never ends on its own", () => {
  expect(subject("fingerprint_fence").release.stalled("agent-a")).toBeDefined();
});

test("a queue-only session's silent busy turn is judged against the hour, not 15 minutes", () => {
  // A session that does not declare `steersBusyTurn` queues a notice until the turn ends: no
  // mid-turn input, so the longer fuse applies.
  const queueOnly = subject(undefined, { provider: "opencode", busyTurn: true });
  queueOnly.advance(STALLED_RECOVERY_SILENCE_MS);
  expect(queueOnly.release.stalled("agent-a")).toBeUndefined();
  queueOnly.advance(STALLED_RECOVERY_SILENCE_QUEUE_ONLY_MS - STALLED_RECOVERY_SILENCE_MS + 1);
  expect(queueOnly.release.stalled("agent-a")).toBeDefined();
});

test("a session declaring steersBusyTurn is judged at 15 minutes whatever its provider", () => {
  const steered = subject(undefined, {
    provider: "opencode",
    busyTurn: true,
    steersBusyTurn: true,
  });
  steered.advance(STALLED_RECOVERY_SILENCE_MS);
  expect(steered.release.stalled("agent-a")).toBeDefined();
});
