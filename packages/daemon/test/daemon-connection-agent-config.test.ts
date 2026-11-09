import { expect, test } from "bun:test";
import {
  DAEMON_RUNTIME_READY_METHOD,
  encodeAgentConfigSync,
  encodeAgentStartIntent,
  encodeAgentStopIntent,
  type AgentConfigSync,
} from "@lrm/coforge-sdk/internal";
import { DaemonConnection } from "#src/connection/daemon-connection";
import type { CentrifugeWorkspaceClient } from "#src/connection/centrifuge-workspace-client";
import { captureDaemonLogs } from "./log-capture";

const config = { workspaceId: "workspace-1", computerId: "computer-1" };
const channel = `daemon:${config.workspaceId}:${config.computerId}`;

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
    publish: (data: Uint8Array) => publication({ channel, data }),
  };
}

const configSync = (overrides: Partial<AgentConfigSync> = {}): AgentConfigSync => ({
  protocolMajor: 1,
  ...config,
  agentId: "agent-1",
  provider: "claude-code",
  model: "opus",
  reasoning: "high",
  revision: 2,
  ...overrides,
});

const readyRequest = () => ({
  protocolMajor: 1,
  requestId: "ready-1",
  ...config,
  workerInstanceId: "runtime-1",
  startedAt: 1,
  runningAgentIds: [],
});

test("an Agent config sync reaches the config listener with its revision", async () => {
  const fake = fakeClient();
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  const received: string[] = [];
  transport.onAgentConfigSync((sync) =>
    received.push(`${sync.agentId}@${sync.revision}:${sync.model}`),
  );
  await transport.start("secret", config);
  fake.publish(encodeAgentConfigSync(configSync({ revision: 7 })));
  expect(received).toEqual(["agent-1@7:opus"]);
});

test("a config sync for another Workspace is rejected at the boundary and never delivered", async () => {
  const fake = fakeClient();
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  const received: string[] = [];
  transport.onAgentConfigSync((sync) => received.push(sync.agentId));
  await transport.start("secret", config);
  const { records } = await captureDaemonLogs(async () => {
    fake.publish(encodeAgentConfigSync(configSync({ workspaceId: "other-workspace" })));
  });
  expect(received).toEqual([]);
  const rejection = records.find((record) => record.properties.event === "daemon_control:rejected");
  // Not an Agent control kind, so it is logged as undecodable instead of routed.
  expect(rejection).toBeDefined();
});

test("while ready waits, only an Agent's latest config sync is held, and it is delivered after ready", async () => {
  const fake = fakeClient();
  const settle = Promise.withResolvers<void>();
  fake.client.rpc = async (method) => {
    if (method === DAEMON_RUNTIME_READY_METHOD) await settle.promise;
    return new Uint8Array();
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  const dispatched: string[] = [];
  transport.onAgentConfigSync((sync) => dispatched.push(`config@${sync.agentId}#${sync.revision}`));
  transport.onAgentStart((intent) => dispatched.push(`start@${intent.agentId}`));
  transport.onAgentStop((intent) => dispatched.push(`stop@${intent.agentId}`));
  await transport.start("secret", config);
  const ready = transport.ready(readyRequest);

  fake.publish(encodeAgentConfigSync(configSync({ revision: 2 })));
  fake.publish(
    encodeAgentStopIntent({ protocolMajor: 1, requestId: "stop-1", ...config, agentId: "agent-1" }),
  );
  fake.publish(encodeAgentConfigSync(configSync({ revision: 3 })));
  fake.publish(
    encodeAgentStartIntent({
      protocolMajor: 1,
      requestId: "start-1",
      ...config,
      agentId: "agent-1",
      provider: "pi",
      model: "default",
      reasoning: "balanced",
    }),
  );
  fake.publish(encodeAgentConfigSync(configSync({ agentId: "agent-2", revision: 1 })));
  expect(dispatched).toEqual([]);

  settle.resolve();
  await ready;
  // The earlier revision of agent-1 is replaced by the later one, which takes the later place;
  // the Stop and Start keep their own places.
  expect(dispatched).toEqual([
    "stop@agent-1",
    "config@agent-1#3",
    "start@agent-1",
    "config@agent-2#1",
  ]);
});
