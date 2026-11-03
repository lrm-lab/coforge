import { expect, test } from "bun:test";
import type { AgentRuntimeConfig } from "@lrm/coforge-anvil";
import {
  LAUNCH_RETRY_TIMER_LIMIT_MS,
  systemLaunchRetryScheduler,
} from "#src/agent-runtime/launch-retry-scheduler";
import {
  AgentOfflineResidency,
  type OfflineResidencyLaunch,
} from "#src/daemon-runtime/agent-offline-residency";
import type { ActivityDraft } from "#src/daemon-runtime/agent-activity-publisher";
import { AgentStopCoordinator } from "#src/daemon-runtime/agent-stop-coordinator";

function residency() {
  return new AgentOfflineResidency({
    endHoldForNextLaunch() {},
    forgetRuntimeErrorHold() {},
    keepInputDeliveriesForNextLaunch() {},
    closeAgentInputQueue() {},
    buildDraft(_agentId, built) {
      return built as unknown as ActivityDraft;
    },
    publish() {},
    sendAgentStatus() {},
    sendAgentActivity() {},
    async stopProcess() {},
  });
}

const config = {
  provider: "command-code",
  model: "grok",
} as Pick<AgentRuntimeConfig, "provider" | "model" | "providerConfig">;

function launch(): OfflineResidencyLaunch {
  return { launchId: "l", clientSeq: 0, stopping: false };
}

test("a duration reset on a thrown launch waits and does not take the agent offline", () => {
  const offline = residency();
  const current = launch();
  const activity = offline.thrownLaunchActivity(
    "a",
    current,
    "Command Code",
    config,
    new Error("You've reached your weekly usage limit. Resets in 3h (3:45pm)."),
  );
  expect(activity?.level).toBe("error");
  expect(activity?.detail).toContain("Resets in 3h");
  expect(activity?.detail).toContain("limit resets at");
  expect(offline.has("a")).toBe(false);
  expect(offline.hasLaunchWait("a")).toBe(true);
  expect(current.offlineError).toBeUndefined();
});

test("a usage limit with no recovery time on a thrown launch is offline", () => {
  const offline = residency();
  const current = launch();
  const activity = offline.thrownLaunchActivity(
    "a",
    current,
    "Codex",
    { provider: "codex", model: "gpt" } as typeof config,
    new Error("You've hit your usage limit."),
  );
  expect(activity?.detail).toContain("stopped retrying");
  expect(offline.has("a")).toBe(true);
  expect(offline.hasLaunchWait("a")).toBe(false);
  expect(current.offlineError).toBe(activity);
});

test("a call-stack throw is not a quota wait", () => {
  const offline = residency();
  const current = launch();
  expect(
    offline.thrownLaunchActivity(
      "a",
      current,
      "Command Code",
      config,
      new Error("Maximum call stack size exceeded"),
    ),
  ).toBeUndefined();
  expect(offline.hasLaunchWait("a")).toBe(false);
  expect(offline.has("a")).toBe(false);
});

test("cleanup of a quota wait does not report the agent inactive", async () => {
  const offline = residency();
  offline.thrownLaunchActivity(
    "a",
    launch(),
    "Command Code",
    config,
    new Error("You've reached your weekly usage limit. Resets in 45m."),
  );
  const statuses: string[] = [];
  const coordinator = new AgentStopCoordinator({
    agentLaunches: new Map(),
    currentActivityLaunches: new Map(),
    inputDrain: { get: () => undefined },
    processManager: { isStopping: () => false, stop: async () => {} },
    activityPublisher: { forgetBusy() {}, publish() {} },
    desktops: { end() {} },
    agentApiKeys: new Map(),
    revokeAgentApiKey: async () => {},
    messageAttention: { clearAgent() {} },
    deliveryQueue: { clearAgent() {} },
    runtimeErrorHold: { forget() {} },
    offlineResidency: offline,
    sendAgentStatus(_agentId: string, status: "active" | "inactive") {
      statuses.push(status);
    },
    publishStopped() {},
  } as never);
  await coordinator.releaseAgentRuntime("a");
  expect(statuses).toEqual([]);
  expect(offline.hasLaunchWait("a")).toBe(false);
  await coordinator.releaseAgentRuntime("a");
  expect(statuses).toEqual(["inactive"]);
});

test("a launch retry longer than one timer re-arms instead of firing immediately", () => {
  const original = globalThis.setTimeout;
  const calls: Array<{ ms: number; fn: () => void }> = [];
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    calls.push({ ms: ms ?? 0, fn });
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    let ran = false;
    const handle = systemLaunchRetryScheduler.schedule(() => {
      ran = true;
    }, LAUNCH_RETRY_TIMER_LIMIT_MS + 10_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ms).toBe(LAUNCH_RETRY_TIMER_LIMIT_MS);
    calls[0]?.fn();
    expect(ran).toBe(false);
    expect(calls[1]?.ms).toBe(10_000);
    calls[1]?.fn();
    expect(ran).toBe(true);
    systemLaunchRetryScheduler.cancel(handle);
  } finally {
    globalThis.setTimeout = original;
  }
});
