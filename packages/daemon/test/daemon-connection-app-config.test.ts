import { expect, test } from "bun:test";
import {
  APP_CONFIG_SNAPSHOT_METHOD,
  APP_CONFIG_SYNC_MESSAGE_TYPE,
  CLEANER_APP_ID,
  decodeAppConfigSnapshotRequest,
  encodeAppConfigSync,
  type AppConfigSync,
} from "@lrm/coforge-sdk/internal";
import type { CentrifugeWorkspaceClient } from "#src/connection/centrifuge-workspace-client";
import { DaemonConnection } from "#src/connection/daemon-connection";

// The App config path over one connection: an upsert publication and the snapshot RPC. They own
// their fake client, so they live apart from the transport suite's shared fixtures.
const config = { computerId: "computer-a", workspaceId: "workspace-a" };

function fakeClient() {
  let connected = () => {};
  let failed = (_error: unknown) => {};
  let disconnected = (_context?: { code: number; reason: string }) => {};
  let publication = (_event: { channel: string; data: Uint8Array }) => {};
  const client: CentrifugeWorkspaceClient = {
    on(event, callback) {
      if (event === "connected") connected = callback as () => void;
      else if (event === "disconnected") disconnected = callback as typeof disconnected;
      else if (event === "error") failed = callback as (error: unknown) => void;
      else publication = callback as typeof publication;
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
    disconnect: (context?: { code: number; reason: string }) => disconnected(context),
    fail: (error: unknown) => failed(error),
    publish: (channel: string, data: Uint8Array) => publication({ channel, data }),
  };
}

const appConfigSync = (computerId: string = config.computerId) =>
  encodeAppConfigSync({
    protocolMajor: 1,
    requestId: "app-config-1",
    workspaceId: config.workspaceId,
    computerId,
    agentId: "agent-1",
    operation: "upsert",
    configs: [
      {
        appId: CLEANER_APP_ID,
        ownerAgentId: "agent-1",
        revision: 1,
        effective: {
          enabled: true,
          thresholdBytes: 65_536,
          activeContextThresholdBytes: 8_000,
          intervalMs: 3_600_000,
        },
      },
    ],
    messageType: APP_CONFIG_SYNC_MESSAGE_TYPE,
  });

test("an App config sync for this Computer reaches its slot and nothing else", async () => {
  const fake = fakeClient();
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  const syncs: AppConfigSync[] = [];
  let other = 0;
  transport.onAppConfigSync((sync) => syncs.push(sync));
  transport.onReminderSync(() => other++);
  transport.onAgentWorkspaceReset(() => other++);
  try {
    await transport.start("secret", config);
    const channel = `daemon:${config.workspaceId}:${config.computerId}`;
    fake.publish(channel, appConfigSync());
    fake.publish(channel, appConfigSync("other-computer"));
    expect(syncs).toMatchObject([{ agentId: "agent-1", operation: "upsert" }]);
    expect(other).toBe(0);
  } finally {
    await transport.stop();
  }
});

test("an App config snapshot is asked for over RPC and its reply decoded", async () => {
  const fake = fakeClient();
  const calls: { method: string; data: Uint8Array }[] = [];
  fake.client.rpc = async (method, data) => {
    calls.push({ method, data });
    return { data: appConfigSync() };
  };
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  try {
    await transport.start("secret", config);
    const request = {
      protocolMajor: 1,
      requestId: "snapshot-1",
      workspaceId: config.workspaceId,
      computerId: config.computerId,
      agentId: "agent-1",
    };
    const reply = await transport.requestAppConfigSnapshot(request);
    expect(reply.configs).toHaveLength(1);
    const call = calls.find(({ method }) => method === APP_CONFIG_SNAPSHOT_METHOD);
    expect(decodeAppConfigSnapshotRequest(call!.data)).toEqual(request);
  } finally {
    await transport.stop();
  }
});
