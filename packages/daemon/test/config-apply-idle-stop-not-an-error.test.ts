import { expect, test } from "bun:test";
import type { AgentRuntimeConfig } from "@lrm/coforge-anvil";
import { observeRuntimeEvent } from "#src/daemon-runtime/runtime-event-observation";
import type { RuntimeEventObservationPorts } from "#src/daemon-runtime/runtime-event-observation-ports";
import type { ActivityLaunch } from "#src/daemon-runtime/activity-launch";
import type { AgentRuntime } from "#src/agent-runtime/agent-process-manager";

/**
 * A configuration push that applies to an idle Agent stops it on purpose, and the stop kills the
 * provider process. That kill surfaces as an `error` event, which used to be classified like any
 * other runtime failure: deliveries went into the runtime-error backoff and the Activity briefly
 * showed an error for a restart nobody asked about (task #35). The reference Computer records such
 * a stop as an intentional restart instead; so does this.
 */
function harness(stopping: boolean) {
  const failures: string[] = [];
  const published: { level: string; kind: string }[] = [];
  const ports = {
    deliveryGate: {
      consumption: { observeRuntimeEvent: () => {} },
      hold: () => {},
      release: () => [],
      pending: () => [],
      explicitHold: () => undefined,
      credentialHeld: () => false,
    },
    activityPublisher: {
      publish: (_id: string, _launch: unknown, activity: { level: string; detailKind: string }) => {
        published.push({ level: activity.level, kind: activity.detailKind });
      },
      lastBusy: () => undefined,
    },
    offlineResidency: { buildActivity: () => ({}), takeOffline: () => {} },
    runtimeErrorHold: {
      noteRuntimeFailure: (_agentId: string, _launch: unknown, event: { message: string }) => {
        failures.push(event.message);
        return { built: {} };
      },
    },
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
    failures,
    published,
    observe: () =>
      observeRuntimeEvent(ports, "agent-1", launch, config, runtime, false, {
        type: "error",
        message: "process exited with code 143",
      }),
  };
}

test("an error during a deliberate stop is the stop, not a runtime failure", () => {
  const x = harness(true);
  x.observe();
  // No retry backoff, and nothing that would show an error in the Activity.
  expect(x.failures).toEqual([]);
  expect(x.published.filter((entry) => entry.level === "error")).toEqual([]);
});

test("the same error on a launch nobody is stopping is still a runtime failure", () => {
  // The guard must be about intent, not about swallowing provider errors.
  const x = harness(false);
  x.observe();
  expect(x.failures).toEqual(["process exited with code 143"]);
});
