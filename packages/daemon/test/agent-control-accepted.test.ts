import { expect, test } from "bun:test";
import type {
  AgentControlResult,
  AgentControlScope,
  AgentStartIntent,
  AgentWorkspaceResetRequest,
} from "@lrm/coforge-sdk/internal";
import {
  DAEMON_RUNTIME_READY_METHOD,
  encodeDaemonRuntimeReadyResponse,
} from "@lrm/coforge-sdk/internal";
import type { CentrifugeWorkspaceClient } from "#src/connection/centrifuge-workspace-client";
import { DaemonConnection } from "#src/connection/daemon-connection";
import {
  composeAgentControl,
  type AgentControlCompositionPorts,
} from "#src/daemon-runtime/agent-control-composition";
import type { DaemonConfig } from "#src/daemon-runtime/runtime";
import type { AgentRuntime } from "#src/agent-runtime/agent-process-manager";

const scope: AgentControlScope = {
  protocolMajor: 1,
  requestId: "req-1",
  workspaceId: "w",
  computerId: "c",
  agentId: "a",
  provider: "codex",
  epoch: 1,
};

const startIntent: AgentStartIntent = {
  protocolMajor: 1,
  requestId: "req-2",
  workspaceId: "w",
  computerId: "c",
  agentId: "a",
  provider: "pi",
  model: "default",
  reasoning: "",
  controlEpoch: 1,
  launchId: "launch-1",
};

const resetRequest: AgentWorkspaceResetRequest = { ...scope, requestId: "req-3" };

function harness(agentControlAccepted: boolean) {
  const sent: AgentControlResult[] = [];
  /** The order in which a stop ends the process and drops what a cold start owed. */
  const calls: string[] = [];
  const ports: AgentControlCompositionPorts = {
    connection: {
      workspaceRoot: "/tmp/coforge-t584-test",
      workspaceId: "w",
    } as unknown as DaemonConfig,
    runtimeInstanceId: "daemon-1",
    running: () => false,
    session: () => undefined,
    stopAgent: async () => {
      calls.push("stop");
    },
    startAgent: async () =>
      ({
        session: {
          readSessionIdentity: async () => ({ sessionId: "native-1", state: "empty" }),
        },
      }) as unknown as AgentRuntime,
    rebind: async () => undefined,
    stops: { forgetSession: () => {} },
    dropOwedRecovery: () => {
      calls.push("dropOwedRecovery");
    },
    startSettled: () => {},
    sendSessionInvalidate: () => {},
    reportSession: async () => {},
    sendControlResult: async (result) => {
      sent.push(result);
    },
    agentControlAccepted: () => agentControlAccepted,
  };
  return { sent, calls, control: composeAgentControl(ports).agentControl };
}

test("a capable server gets `accepted` ahead of the serialized stop result", async () => {
  const { sent, control } = harness(true);
  await control.stop(scope);
  expect(sent.map((result) => result.phase)).toEqual(["accepted", "stopped"]);
  expect(sent[0]).toMatchObject({
    requestId: scope.requestId,
    agentId: scope.agentId,
    epoch: scope.epoch,
    sequence: 1,
  });
});

test("an accepted Stop drops what was owed before it ends the process, and a stale one never does", async () => {
  const { calls, control } = harness(true);
  await control.start(startIntent);

  // Older than the Start that launched the Agent: the control fence refuses it.
  await expect(control.stop({ ...scope, epoch: 0, requestId: "req-stale" })).rejects.toThrow(
    "stale_control_request",
  );
  expect(calls).toEqual([]);

  await control.stop({ ...scope, epoch: 2, requestId: "req-accepted" });
  expect(calls).toEqual(["dropOwedRecovery", "stop"]);
});

test("an old server that never confirmed the phase sees no `accepted` result", async () => {
  const { sent, control } = harness(false);
  await control.stop(scope);
  expect(sent.map((result) => result.phase)).toEqual(["stopped"]);
});

test("reset-workspace acknowledges before its terminal result", async () => {
  const { sent, control } = harness(true);
  // A workspace reset is fenced behind a confirmed stop of the same epoch.
  await control.stop(scope);
  sent.length = 0;
  await control.resetWorkspace(resetRequest);
  expect(sent[0]?.phase).toBe("accepted");
  expect(sent.at(-1)?.phase).toBe("workspace-reset");
});

test("a managed start acknowledges before the launch's own result", async () => {
  const { sent, control } = harness(true);
  await control.start(startIntent);
  expect(sent[0]?.phase).toBe("accepted");
  expect(sent[0]).toMatchObject({ requestId: startIntent.requestId, epoch: 1 });
  expect(sent.some((result) => result.phase === "started")).toBe(true);
});

/** The smallest CentrifugeWorkspaceClient the connection's ready path needs. */
function readyFlagClient(replies: Uint8Array[]) {
  let connected = () => {};
  const client: CentrifugeWorkspaceClient = {
    on(event, callback) {
      if (event === "connected") connected = callback as () => void;
    },
    connect() {
      connected();
    },
    disconnect() {},
    rpc: async (method) => ({
      data:
        method === DAEMON_RUNTIME_READY_METHOD
          ? (replies.shift() ?? new Uint8Array())
          : new Uint8Array(),
    }),
  };
  return { client, reconnect: () => connected() };
}

test("the ready reply gates `agentControlAccepted`, and an older reply clears it", async () => {
  const { client, reconnect } = readyFlagClient([
    encodeDaemonRuntimeReadyResponse({ agentControlAccepted: true }),
    encodeDaemonRuntimeReadyResponse({}),
  ]);
  const transport = new DaemonConnection("wss://cloud.example", () => client);
  const config = { computerId: "computer-a", workspaceId: "workspace-a" };
  const readyRequest = () => ({
    protocolMajor: 1,
    requestId: crypto.randomUUID(),
    workspaceId: config.workspaceId,
    computerId: config.computerId,
    workerInstanceId: "runtime-1",
    startedAt: 123,
    runningAgentIds: [],
  });
  await transport.start("secret", config);
  await transport.ready(readyRequest);
  expect(transport.agentControlAccepted()).toBe(true);

  // A reconnect whose ready reply lacks the flag is an older server: the stale `true` must go.
  let reconnected!: () => void;
  const reconnectedPromise = new Promise<void>((resolve) => (reconnected = resolve));
  transport.onReconnect(reconnected);
  reconnect();
  await reconnectedPromise;
  // The resent ready's reply clears the flag once it is decoded; poll the observable.
  for (let i = 0; i < 100 && transport.agentControlAccepted(); i++) await Bun.sleep(1);
  expect(transport.agentControlAccepted()).toBe(false);
  await transport.stop();
});
