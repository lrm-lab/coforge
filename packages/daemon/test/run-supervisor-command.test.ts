import { describe, expect, test } from "bun:test";
import type { ManagedRuntimeIdentity, ManagedRunnerIdentity } from "@lrm/coforge-sdk/internal";
import type { ComputerSelfClient } from "#src/connection/computer-self-client";
import { runWorkspaceCommand } from "#src/supervisor/run-supervisor-command";
import type { MachineSupervisor } from "#src/supervisor/machine-supervisor";

/** `command()`'s own dispatch (task #417): every lifecycle method routes correctly — start,
 * stop and restart dispatch to the supervisor; upgrade, upgrade_ack and detach run their own
 * op and answer the view; the snapshot answers the view alone. */
const view = async () => [] as ManagedRuntimeIdentity[];
const request = (method: string) => ({
  protocolMajor: 1,
  requestId: `req-${method}`,
  expectedServerUrl: "http://server",
  workspaceId: "ws-1",
});
const deps = (overrides: Partial<Parameters<typeof runWorkspaceCommand>[0]> = {}) => ({
  method: "",
  request: request(""),
  supervisor: {} as MachineSupervisor,
  workspaceDirectory: (id: string) => `/ws/${id}`,
  stateDirectory: "/state",
  refreshChildUpgradeConfig: async () => {},
  completeUpgrade: async () => ({}),
  watchPendingUpgrade: () => {},
  launchComputerUpgrade: async () => {},
  makeSelfClient: () =>
    ({
      detach: async () => ({ ok: true, value: "detached" as const }),
    }) satisfies Pick<ComputerSelfClient, "detach">,
  view,
  startForOperator: async () => [],
  ownServerUrl: "http://server",
  ...overrides,
});

test("start and restart go through startForOperator; stop goes through supervisor.command", async () => {
  const started: string[] = [];
  const stopped: string[] = [];
  const d = deps({
    startForOperator: async (operation) => {
      started.push(operation);
      return [];
    },
    supervisor: {
      command: async (operation: string) => {
        stopped.push(operation);
        return { started: [], pending: [] };
      },
    } as unknown as MachineSupervisor,
  });
  await runWorkspaceCommand(
    deps({ ...d, method: "daemon:start", request: request("daemon:start") }),
  );
  await runWorkspaceCommand(
    deps({ ...d, method: "daemon:restart", request: request("daemon:restart") }),
  );
  await runWorkspaceCommand(deps({ ...d, method: "daemon:stop", request: request("daemon:stop") }));
  expect(started).toEqual(["start", "restart"]);
  expect(stopped).toEqual(["stop"]);
});

test("upgrade, upgrade_ack and detach answer the view; the snapshot does too", async () => {
  const recorded: string[] = [];
  const acknowledged: string[] = [];
  const detached: string[] = [];
  const d = deps({
    supervisor: {
      recordUpgrade: async () => {
        recorded.push("recorded");
        return true;
      },
      acknowledgeUpgrade: async () => {
        acknowledged.push("acknowledged");
        return true;
      },
      detach: async () => {
        detached.push("detached");
        return { detached: true };
      },
      // The upgrade record is machine-wide, so the command reads the bindings it fans out onto.
      // The copy answers `daemon:upgrade_ack`'s own request, and a settled copy is what that
      // command may acknowledge.
      snapshot: async () => [
        {
          workspaceId: "ws-1",
          upgradeOperations: [
            {
              requestId: "req-daemon:upgrade_ack",
              expectedVersion: "1.2.3",
              state: "failed" as const,
              requestedAt: 1,
              terminal: { at: 2, status: "failed" as const },
            },
          ],
        },
      ],
    } as unknown as MachineSupervisor,
  });
  for (const method of [
    "daemon:upgrade",
    "daemon:upgrade_ack",
    "daemon:detach",
    "daemon:snapshot",
  ]) {
    const result = await runWorkspaceCommand(
      deps({
        ...d,
        method,
        request: {
          ...request(method),
          expectedVersion: "1.2.3",
          computerId: "c1",
          serverHttpUrl: "http://server",
        },
      }),
    );
    // The view answers each; the detach's is the keyed marker, the rest the bare view.
    expect(result).toEqual(
      method === "daemon:detach" ? { runtimes: [], detachKeyRevoked: false } : [],
    );
  }
  expect(recorded).toEqual(["recorded"]);
  expect(acknowledged).toEqual(["acknowledged"]);
  expect(detached).toEqual(["detached"]);
});

test("runner commands stay scoped to the requested Workspace and Agent", async () => {
  const calls: string[] = [];
  const runners: ManagedRunnerIdentity[] = [
    {
      workspaceId: "ws-1",
      agentId: "agent-1",
      provider: "pi",
      model: "default",
      state: "running",
    },
  ];
  const result = await runWorkspaceCommand(
    deps({
      method: "daemon:runners:stop",
      runnerCommand: async (operation, workspaceId, agentId) => {
        calls.push(`${operation}:${workspaceId}:${agentId}`);
        return runners;
      },
      request: { ...request("daemon:runners:stop"), agentId: "agent-1" },
    }),
  );
  expect(calls).toEqual(["stop:ws-1:agent-1"]);
  expect(result).toEqual({ runtimes: [], runners });
});
