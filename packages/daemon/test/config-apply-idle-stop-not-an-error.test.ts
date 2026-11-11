import { expect, test } from "bun:test";
import type { AgentRuntimeConfig } from "@lrm/coforge-anvil";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { observeRuntimeEvent } from "#src/daemon-runtime/runtime-event-observation";
import type { RuntimeEventObservationPorts } from "#src/daemon-runtime/runtime-event-observation-ports";
import { RuntimeErrorDeliveryHold } from "#src/daemon-runtime/runtime-error-delivery-hold";
import type { ActivityLaunch } from "#src/daemon-runtime/activity-launch";
import type { AgentRuntime } from "#src/agent-runtime/agent-process-manager";
import type { DeliveryHoldReason } from "#src/daemon-runtime/agent-delivery-gate";

/**
 * A configuration push that applies to an idle Agent stops it on purpose, and the stop kills the
 * provider process. That kill surfaces as an `error` event, which used to be classified like any
 * other runtime failure: the delivery waiting for the Agent went into the runtime-error backoff for
 * about ten seconds and the Activity briefly showed an error, for a restart nobody asked about
 * (task #35, seen on 0.1.28 at 03:00:09Z).
 *
 * Both halves matter: the stop is not a failure, and the message the Agent was about to be given
 * waits for the relaunched process instead of being held behind an error or dropped.
 */
const pendingDelivery = { deliveryId: "delivery-1" } as AgentMessageDelivery;

function harness(stopping: boolean) {
  const queued = [pendingDelivery];
  const holds: { agentId: string; reason: DeliveryHoldReason }[] = [];
  const releases: string[] = [];
  const endHolds: string[] = [];
  const ports = {
    deliveryGate: {
      consumption: { observeRuntimeEvent: () => {} },
      hold: (agentId: string, reason: DeliveryHoldReason) => holds.push({ agentId, reason }),
      release: (agentId: string) => {
        releases.push(agentId);
        return [];
      },
      endHoldForNextLaunch: (agentId: string) => endHolds.push(agentId),
      explicitHold: () => holds.at(-1)?.reason,
      credentialHeld: () => false,
      pending: () => queued,
    },
    runtimeErrorHold: new RuntimeErrorDeliveryHold({
      deliveryGate: {
        hold: (agentId: string, reason: DeliveryHoldReason) => holds.push({ agentId, reason }),
        release: (agentId) => {
          releases.push(agentId);
          return [];
        },
        endHoldForNextLaunch: (agentId) => endHolds.push(agentId),
        explicitHold: () => holds.at(-1)?.reason,
        credentialHeld: () => false,
        pending: () => queued,
      },
      flush: () => {},
    }),
    activityPublisher: {
      publish: () => {},
      lastBusy: () => undefined,
    },
    offlineResidency: { buildActivity: () => ({}), takeOffline: () => {} },
    credentialHolds: { record: () => {} },
    phaseBookkeeping: {
      start: () => {},
      finish: () => {},
      interrupt: () => {},
      compactionError: () => {},
      compactionTokens: () => {},
    },
    mentionDeliveries: { drop: () => {} },
    agentSessions: {},
    systemCleaner: { onAgentWorkingToIdle: () => {} },
    collectSkillAgents: new Set<string>(),
    fastModeWarned: new Set<string>(),
    isWorking: () => false,
    activityDraft: (_id: string, kind: string, level: string) => ({ detailKind: kind, level }),
    runtimeErrorActivity: () => ({ detailKind: "error", level: "error" }),
    interruptedActivity: () => ({ detailKind: "interrupted", level: "warning" }),
    showQuietTurn: () => {},
    reconcileIdleTurn: () => false,
    rememberUsage: () => {},
    releaseTurnEndHolds: () => {},
    drainAppInboxNotices: async () => {},
    failCollectorRunningSlots: async () => {},
  } as unknown as RuntimeEventObservationPorts;
  const launch = { launchId: "launch-1", clientSeq: 0, stopping } as ActivityLaunch;
  const runtime = { session: { hasLiveTurn: false } } as unknown as AgentRuntime;
  const config = { provider: "kiro" } as AgentRuntimeConfig;
  return {
    queued,
    holds,
    releases,
    endHolds,
    observe: () =>
      observeRuntimeEvent(ports, "agent-1", launch, config, runtime, false, {
        type: "error",
        message: "process exited with code 143",
      }),
  };
}

test("an error during a deliberate stop holds nothing: the waiting message goes to the next launch", () => {
  const x = harness(true);
  x.observe();
  expect(x.holds).toEqual([]);
  // The observation neither released nor dropped the queue, and never ended a hold on its own
  // account: the delivery is still there for the process the restart launches.
  expect(x.releases).toEqual([]);
  expect(x.endHolds).toEqual([]);
  expect(x.queued).toEqual([pendingDelivery]);
});

test("the same error on a launch nobody is stopping still backs off its deliveries", () => {
  // The guard is about intent, not about swallowing provider errors.
  const x = harness(false);
  x.observe();
  expect(x.holds).toEqual([{ agentId: "agent-1", reason: "runtime_error_backoff" }]);
  expect(x.releases).toEqual([]);
  expect(x.queued).toEqual([pendingDelivery]);
});
