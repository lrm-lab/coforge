import { expect, test } from "bun:test";
import {
  AGENT_TURN_INTERRUPT_RESULT_METHOD,
  DAEMON_RUNTIME_READY_METHOD,
  decodeAgentTurnInterruptResult,
  encodeAgentTurnInterruptIntent,
  type AgentTurnInterruptIntent,
} from "@lrm/coforge-sdk/internal";
import { DaemonConnection } from "#src/connection/daemon-connection";
import type { CentrifugeWorkspaceClient } from "#src/connection/centrifuge-workspace-client";

const config = { workspaceId: "workspace-1", computerId: "computer-1" };

function fakeClient() {
  let connected = () => {};
  let publication = (_event: { channel: string; data: Uint8Array }) => {};
  const client: CentrifugeWorkspaceClient = {
    on(event, callback) {
      if (event === "connected") connected = callback as () => void;
      else if (event === "publication") publication = callback as typeof publication;
    },
    connect() {
      connected();
    },
    disconnect() {},
    rpc: async () => new Uint8Array(),
  };
  return {
    client,
    connect: () => connected(),
    publish: (channel: string, data: Uint8Array) => publication({ channel, data }),
  };
}

test("sends and receives turn interrupt protocol messages", async () => {
  const fake = fakeClient();
  const calls: string[] = [];
  fake.client.rpc = async (method, data) => {
    calls.push(method);
    if (method === AGENT_TURN_INTERRUPT_RESULT_METHOD)
      expect(decodeAgentTurnInterruptResult(data)).toMatchObject({ status: "restarted" });
    return new Uint8Array();
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  const received: string[] = [];
  transport.onAgentTurnInterrupt((intent) => received.push(intent.agentId));
  await transport.start("secret", config);
  await transport.sendAgentTurnInterruptResult({
    protocolMajor: 1,
    requestId: "result-1",
    ...config,
    agentId: "agent-1",
    provider: "pi",
    epoch: 1,
    launchId: "launch-1",
    status: "restarted",
    toolName: "Bash",
    silentForMs: 1,
  });
  const intent: AgentTurnInterruptIntent = {
    protocolMajor: 1,
    requestId: "intent-1",
    ...config,
    agentId: "agent-1",
    provider: "pi",
    epoch: 1,
    launchId: "launch-1",
  };
  fake.publish(
    `daemon:${config.workspaceId}:${config.computerId}`,
    encodeAgentTurnInterruptIntent(intent),
  );
  expect(calls).toContain(AGENT_TURN_INTERRUPT_RESULT_METHOD);
  expect(received).toEqual(["agent-1"]);
});

test("while ready waits, a turn interrupt is dropped rather than replayed after the handshake", async () => {
  const fake = fakeClient();
  const settle = Promise.withResolvers<void>();
  fake.client.rpc = async (method) => {
    if (method === DAEMON_RUNTIME_READY_METHOD) await settle.promise;
    return new Uint8Array();
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  const dispatched: string[] = [];
  transport.onAgentTurnInterrupt((intent) => dispatched.push(intent.requestId));
  await transport.start("secret", config);
  const ready = transport.ready(() => ({
    protocolMajor: 1,
    requestId: "ready-1",
    ...config,
    workerInstanceId: "runtime-1",
    startedAt: 123,
    runningAgentIds: [],
  }));

  fake.publish(
    `daemon:${config.workspaceId}:${config.computerId}`,
    encodeAgentTurnInterruptIntent({
      protocolMajor: 1,
      requestId: "interrupt-1",
      ...config,
      agentId: "agent-1",
      provider: "pi",
      epoch: 1,
      launchId: "launch-1",
    }),
  );
  settle.resolve();
  await ready;

  expect(dispatched).toEqual([]);
});
