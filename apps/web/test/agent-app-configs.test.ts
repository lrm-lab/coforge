import { expect, test } from "bun:test";
import {
  CLEANER_APP_ID,
  CLEANER_CONFIG_DEFAULTS,
  decodeAppConfigSync,
  encodeAppConfigSnapshotRequest,
  type AppConfigSync,
} from "@lrm/coforge-sdk/internal";
import {
  AgentAppConfigs,
  type AgentAppConfigRepository,
  type StoredAgentAppConfig,
} from "#src/server/agent-app-configs/agent-app-configs.server";
import { createAppConfigSnapshotMethod } from "#src/server/centrifugo/rpc-handler.server";

const agent = { id: "agent-1", workspaceId: "workspace-1", computerId: "computer-1" };
const request = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: agent.workspaceId,
  computerId: agent.computerId,
  agentId: agent.id,
};
const cleanerSettings = { enabled: false, thresholdBytes: 8192, intervalMs: 1_800_000 };
const stored: StoredAgentAppConfig = {
  appId: CLEANER_APP_ID,
  revision: 4,
  config: cleanerSettings,
};

function harness(
  options: {
    rows?: StoredAgentAppConfig[];
    supports?: boolean;
    computerId?: string | null;
    publish?: (sync: AppConfigSync) => Promise<void>;
  } = {},
) {
  const published: AppConfigSync[] = [];
  const repository: AgentAppConfigRepository = {
    async placement(agentId) {
      if (agentId !== agent.id) return undefined;
      return {
        workspaceId: agent.workspaceId,
        computerId: options.computerId === undefined ? agent.computerId : options.computerId,
      };
    },
    async list(agentId) {
      return agentId === agent.id ? (options.rows ?? []) : [];
    },
  };
  const configs = new AgentAppConfigs(
    repository,
    { supports: async () => options.supports ?? true },
    options.publish ??
      (async (sync) => {
        published.push(sync);
      }),
  );
  return { configs, published };
}

test("an Agent with no stored row has every App's defaults at revision 0", async () => {
  const { configs } = harness();
  expect(await configs.configs(agent.id)).toEqual([
    {
      appId: CLEANER_APP_ID,
      ownerAgentId: agent.id,
      revision: 0,
      effective: CLEANER_CONFIG_DEFAULTS,
    },
  ]);
});

test("a stored row is the App's effective configuration at its revision", async () => {
  const { configs } = harness({ rows: [stored] });
  expect(await configs.configs(agent.id)).toEqual([
    { appId: CLEANER_APP_ID, ownerAgentId: agent.id, revision: 4, effective: cleanerSettings },
  ]);
});

test("a stored row for an App the server no longer knows is left out", async () => {
  const { configs } = harness({ rows: [{ appId: "system.retired", revision: 1, config: {} }] });
  expect((await configs.configs(agent.id)).map((config) => config.revision)).toEqual([0]);
});

test("the daemon running the Agent gets every App's configuration in one snapshot", async () => {
  const { configs } = harness({ rows: [stored] });
  const sync = decodeAppConfigSync(await configs.snapshotForDaemon(request));
  expect(sync).toMatchObject({
    ...request,
    operation: "snapshot",
    configs: [{ appId: CLEANER_APP_ID, ownerAgentId: agent.id, revision: 4 }],
  });
});

test("a daemon on another Computer is refused the Agent's snapshot", async () => {
  const { configs } = harness({ computerId: "computer-2" });
  await expect(configs.snapshotForDaemon(request)).rejects.toThrow("not authorized");
  await expect(configs.snapshotForDaemon({ ...request, agentId: "agent-2" })).rejects.toThrow(
    "not authorized",
  );
});

test("a change is pushed as one upsert to a daemon that understands App config", async () => {
  const { configs, published } = harness({ rows: [stored] });
  expect(await configs.publishAppConfig(agent.id, CLEANER_APP_ID)).toBe(true);
  expect(published).toMatchObject([
    {
      workspaceId: agent.workspaceId,
      computerId: agent.computerId,
      agentId: agent.id,
      operation: "upsert",
      configs: [{ appId: CLEANER_APP_ID, revision: 4, effective: cleanerSettings }],
    },
  ]);
});

test("nothing is pushed to an older daemon, an Agent with no Computer, or for an unknown App", async () => {
  for (const options of [{ supports: false }, { computerId: null }]) {
    const { configs, published } = harness(options);
    expect(await configs.publishAppConfig(agent.id, CLEANER_APP_ID)).toBe(false);
    expect(published).toEqual([]);
  }
  const { configs, published } = harness();
  expect(await configs.publishAppConfig(agent.id, "system.unknown")).toBe(false);
  expect(await configs.publishAppConfig("agent-2", CLEANER_APP_ID)).toBe(false);
  expect(published).toEqual([]);
});

test("a failed push is left to the daemon's next snapshot", async () => {
  const { configs } = harness({
    publish: async () => {
      throw new Error("centrifugo unavailable");
    },
  });
  expect(await configs.publishAppConfig(agent.id, CLEANER_APP_ID)).toBe(false);
});

test("the snapshot RPC answers the requesting daemon and refuses another scope", async () => {
  const { configs } = harness();
  const method = createAppConfigSnapshotMethod(configs);
  const principal = {
    userId: "user-1",
    workspaceId: agent.workspaceId,
    computerId: agent.computerId,
  };
  const reply = await method(encodeAppConfigSnapshotRequest(request), { principal });
  expect(reply).toBeInstanceOf(Uint8Array);
  expect(decodeAppConfigSync(reply as Uint8Array).configs).toHaveLength(1);
  expect(
    await method(encodeAppConfigSnapshotRequest(request), {
      principal: { ...principal, computerId: "computer-2" },
    }),
  ).toMatchObject({ code: 403 });
});
