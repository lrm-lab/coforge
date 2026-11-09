import { expect, test } from "bun:test";
import type { AgentActivity } from "@lrm/coforge-sdk/internal";
import {
  AgentOfflineResidency,
  type AgentOfflineResidencyPorts,
  type OfflineResidencyLaunch,
} from "#src/daemon-runtime/agent-offline-residency";
import { idleActivityDraft } from "#src/daemon-runtime/activity-draft";

const WORKSPACE = "ws-1";
const AGENT = "agent-1";

function residency() {
  const activities: AgentActivity[] = [];
  const ports: AgentOfflineResidencyPorts = {
    endHoldForNextLaunch: () => {},
    forgetRuntimeErrorHold: () => {},
    keepInputDeliveriesForNextLaunch: () => {},
    closeAgentInputQueue: () => {},
    buildDraft: () => idleActivityDraft(WORKSPACE, AGENT),
    publish: () => {},
    sendAgentStatus: () => {},
    sendAgentActivity: (activity) => activities.push(activity),
    stopProcess: async () => {},
  };
  return { value: new AgentOfflineResidency(ports), activities };
}

function remembered(provider?: OfflineResidencyLaunch["provider"]) {
  const { value, activities } = residency();
  const launch: OfflineResidencyLaunch = {
    launchId: "launch-1",
    clientSeq: 3,
    stopping: true,
    ...(provider ? { provider } : {}),
  };
  value.remember(AGENT, { launch, draft: idleActivityDraft(WORKSPACE, AGENT) });
  return { value, activities };
}

test("a restated offline Activity carries the dead launch's provider (task #611)", () => {
  const { value, activities } = remembered("claude-code");

  value.restate(AGENT);

  expect(activities).toHaveLength(1);
  expect(activities[0]).toMatchObject({
    agentId: AGENT,
    launchId: "launch-1",
    clientSeq: 4,
    runtimeProvider: "claude-code",
  });
});

test("a launch that cannot name its provider restates without the field", () => {
  const { value, activities } = remembered();

  value.restate(AGENT);

  expect(activities).toHaveLength(1);
  expect(activities[0]!.runtimeProvider).toBeUndefined();
});

/** A launch of `provider` that threw with the given text, as the startup failure path reports it. */
function launchThrew(provider: "codex" | "claude-code", text: string) {
  const { value } = residency();
  const launch: OfflineResidencyLaunch = {
    launchId: "launch-1",
    clientSeq: 0,
    stopping: false,
    provider,
  };
  value.thrownLaunchActivity(
    AGENT,
    launch,
    provider,
    { provider, model: "default" },
    new Error(text),
  );
  return value;
}

const QUOTA_REACHED = "You've reached your weekly usage limit. Resets in 3h (3:45pm).";

test("a lifted provider limit ends the launch wait that provider's quota caused", () => {
  const value = launchThrew("codex", QUOTA_REACHED);
  expect(value.hasLaunchWait(AGENT)).toBe(true);

  expect(value.endLaunchWaits("claude-code")).toBe(0);
  expect(value.hasLaunchWait(AGENT)).toBe(true);

  expect(value.endLaunchWaits("codex")).toBe(1);
  expect(value.hasLaunchWait(AGENT)).toBe(false);
  expect(value.endLaunchWaits("codex")).toBe(0);
});

test("a launch that failed without a quota wait has none to end", () => {
  const value = launchThrew("codex", "spawn blew up");

  expect(value.hasLaunchWait(AGENT)).toBe(false);
  expect(value.endLaunchWaits("codex")).toBe(0);
});
