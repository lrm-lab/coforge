import { expect, test } from "bun:test";
import type { AgentSession } from "@lrm/coforge-anvil";
import type { AgentRestartConfig } from "#src/agent-runtime/agent-process-manager";
import { RuntimeRelease, type RuntimeReleasePorts } from "#src/daemon-runtime/runtime-release";
import {
  STALLED_RECOVERY_SILENCE_MS,
  ProviderProgress,
} from "#src/daemon-runtime/stalled-recovery";
import type { DeliveryHoldReason } from "#src/daemon-runtime/agent-delivery-queue";

type Launch = { stopping: boolean; progress?: ProviderProgress };

/** A queued delivery whose turn never began, with no live turn: the stall branch that fires for
 * an idle runtime, and the one a provider-limit hold must keep from restarting. */
function subject(hold: DeliveryHoldReason | undefined) {
  const launch: Launch = { stopping: false, progress: new ProviderProgress() };
  const session = { hasLiveTurn: false } as unknown as AgentSession;
  const restart: AgentRestartConfig = {
    config: { provider: "pi", model: "m", modelProvider: "anthropic", reasoning: "balanced" },
    sessionId: "native-1",
  };
  const ports: RuntimeReleasePorts<Launch> = {
    launch: () => launch,
    runtime: () => ({ session }) as never,
    restartConfig: () => restart,
    lastBusy: () => undefined,
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
  return new RuntimeRelease(ports);
}

test("a delivery held for a provider limit waits for the reset instead of a restart", () => {
  expect(subject("rate_limit_backoff").stalled("agent-a")).toBeUndefined();
});

test("a delivery held for another retryable failure waits out its delay too", () => {
  expect(subject("runtime_error_backoff").stalled("agent-a")).toBeUndefined();
});

test("without a hold, the same queued delivery is still a stall", () => {
  expect(subject(undefined).stalled("agent-a")).toBeDefined();
});
