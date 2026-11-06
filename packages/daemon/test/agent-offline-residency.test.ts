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
