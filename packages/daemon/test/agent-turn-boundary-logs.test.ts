import { expect, test } from "bun:test";
import type { AgentTurnInterruptIntent } from "@lrm/coforge-sdk/internal";
import { abandonLaunch } from "#src/daemon-runtime/agent-startup-failure";
import type { ActivityLaunch } from "#src/daemon-runtime/activity-launch";
import { interruptAgentTurn } from "#src/daemon-runtime/turn-interrupt";
import { captureDaemonLogs } from "./log-capture";

const launch = { launchId: "launch-1", clientSeq: 1, stopping: false } satisfies ActivityLaunch;

const intent = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId: "agent-1",
  provider: "pi",
  epoch: 1,
  launchId: "launch-1",
} satisfies AgentTurnInterruptIntent;

test("a turn interrupt intent that reached the daemon is logged with its outcome", async () => {
  const { records } = await captureDaemonLogs(async () => {
    await interruptAgentTurn(
      {
        launch: () => launch,
        interrupt: async () => "interrupted",
        publish: () => {},
        report: async () => {},
      },
      intent,
    );
  });
  const accepted = records.find(
    (record) => record.properties.event === "agent_turn_interrupt:accepted",
  );
  expect(accepted?.properties).toMatchObject({
    request_id: "request-1",
    agent_id: "agent-1",
    launch_id: "launch-1",
    status: "interrupted",
    outcome: "accepted",
  });
  // Only identity and outcome: the intent carries no user content, and none may leak either.
  expect(Object.keys(accepted?.properties ?? {})).not.toContain("provider");
});

test("an interrupt naming a launch the daemon no longer runs is logged too", async () => {
  const { records } = await captureDaemonLogs(async () => {
    await interruptAgentTurn(
      {
        launch: () => undefined,
        interrupt: async () => "interrupted",
        publish: () => {},
        report: async () => {},
      },
      intent,
    );
  });
  const accepted = records.find(
    (record) => record.properties.event === "agent_turn_interrupt:accepted",
  );
  expect(accepted?.properties).toMatchObject({
    agent_id: "agent-1",
    launch_id: "launch-1",
    status: "not_running",
    outcome: "accepted",
  });
});

test("an abandoned launch is logged with the launch it tore down", async () => {
  const closed: string[] = [];
  const { records } = await captureDaemonLogs(async () => {
    await abandonLaunch(
      {
        stopping: false,
        stops: {
          markStopping: () => {},
          pendingStop: () => undefined,
          forgetStopping: () => {},
        },
        inputDrain: { close: (agentId: string) => closed.push(agentId) },
        currentActivityLaunches: new Map([["agent-1", launch]]),
        interruptIfBusy: () => {},
        activityPublisher: { forgetBusy: () => {}, publish: () => {} },
        disposeLaunchObservations: () => {},
        revokeLocalLaunch: () => {},
        offlineResidency: { record: () => undefined, remember: () => {} },
        stopCoordinator: { releaseAgentRuntime: async () => {} },
        drafts: { runtimeError: () => ({}) as never },
        agentControl: { stopped: async () => {} },
      },
      "agent-1",
      new Error("Agent runtime did not become ready"),
    );
  });
  const abandoned = records.find((record) => record.properties.event === "agent:launch_abandoned");
  expect(abandoned?.properties).toMatchObject({
    agent_id: "agent-1",
    launch_id: "launch-1",
    error_code: "Error",
    outcome: "abandoned",
  });
  expect(closed).toEqual(["agent-1"]);
});
