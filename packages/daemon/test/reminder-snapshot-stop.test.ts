import { expect, test } from "bun:test";
import type { RuntimeAppInboxSyncPorts } from "#src/daemon-runtime/runtime-app-inbox-sync";
import { requestReminderSnapshot } from "#src/daemon-runtime/runtime-app-inbox-sync";
import { RuntimeStop, type RuntimeStopPorts } from "#src/daemon-runtime/runtime-stop";
import { captureDaemonLogs } from "./log-capture";

const noop = () => {};

/** Every collaborator `RuntimeStop.run` touches, inert; only the stop signal is inspected. */
const stopPorts = () =>
  ({
    startup: { close: async () => {}, unsubscribeAll: noop, abort: noop, pending: () => undefined },
    sweeps: { stop: noop },
    configApply: { dispose: noop },
    machineStatus: { stop: noop },
    contextView: { stopMaintenance: noop },
    activityPublisher: { disable: noop },
    currentActivityLaunches: new Map(),
    phaseBookkeeping: { disposeAll: noop },
    runtimeErrorHold: { disposeAll: noop },
    upgradeResults: { stop: noop },
    usageReport: { clear: noop },
    fastModeWarned: new Set<string>(),
    inputDrain: { entries: () => new Map(), close: noop, drains: () => [] },
    agentLaunches: new Map(),
    agentProcessManager: {
      activeAgentIds: () => [],
      shutdown: async () => {},
      session: () => undefined,
    },
    stops: { beginAll: noop, clear: noop },
    launchCoordinator: { clearOwedRecovery: noop },
    messageAttention: { clearAgent: noop },
    mentionDeliveries: { cancelAgent: noop, cancelAll: noop },
    reminders: { stop: noop, awaitIdle: async () => {} },
    systemCleaner: { clear: noop },
    migrations: undefined,
    agentProxy: undefined,
    agentProxyTokens: new Map<string, string>(),
    agentContexts: new Map<string, string>(),
    agentControl: { dispose: noop, stopped: async () => {} },
    agentSessions: { replay: async () => {} },
    connection: { computerId: "" },
    transport: () => ({}) as never,
    envelope: () => ({}) as never,
    runtimeInstanceId: "runtime-1",
    agentApiKeys: new Map<string, string>(),
    revokeAgentApiKey: async () => {},
    replaceTransport: async () => undefined,
    consumedSeqs: { close: async () => {} },
    sendAgentStatus: noop,
  }) as unknown as RuntimeStopPorts;

/** Nothing a reminder retry does may outlive `stop()`: the closing flow is what tells it so. */
test("the stop in progress aborts the signal a reminder ask waits on", async () => {
  const stop = new RuntimeStop(stopPorts());
  expect(stop.stopSignal.aborted).toBe(false);
  const running = stop.run("computer_restart");
  expect(stop.stopSignal.aborted).toBe(true);
  await running;
});

test("an ask that started after the stop asks nothing and logs nothing", async () => {
  const stop = new RuntimeStop(stopPorts());
  const running = stop.run("computer_restart");
  const applied: string[] = [];
  let asks = 0;
  const { records } = await captureDaemonLogs(async () => {
    const outcome = await requestReminderSnapshot(
      {
        transport: () => ({
          requestSnapshot: async () => {
            asks++;
            throw new Error("connection closed");
          },
        }),
        reminders: {
          apply: async (sync: { agentId: string }) => {
            applied.push(sync.agentId);
          },
        },
        env: () => ({ workspaceId: "workspace-1", computerId: "computer-1", protocolMajor: 1 }),
        signal: stop.stopSignal,
      } as unknown as RuntimeAppInboxSyncPorts,
      "agent-1",
      { reason: "connection" },
    );
    expect(outcome).toBe("stopped");
  });
  await running;
  expect(asks).toBe(0);
  expect(applied).toEqual([]);
  expect(records).toEqual([]);
});
