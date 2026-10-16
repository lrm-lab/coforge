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
// A row holds only the keys the Agent overrode, as it set them.
const stored: StoredAgentAppConfig = {
  appId: CLEANER_APP_ID,
  revision: 4,
  config: { enabled: false, threshold_bytes: 8192, interval_seconds: 1800 },
};
const cleanerSchema = {
  enabled: { type: "boolean" },
  threshold_bytes: { type: "integer", minimum: 4096, maximum: 1_073_741_824 },
  interval_seconds: { type: "integer", minimum: 900, maximum: 604_800 },
} as const;
const cleanerDefaults = { enabled: true, threshold_bytes: 8_192, interval_seconds: 3600 };

function harness(
  options: {
    rows?: StoredAgentAppConfig[];
    supports?: boolean;
    computerId?: string | null;
    publish?: (sync: AppConfigSync) => Promise<void>;
  } = {},
) {
  const published: AppConfigSync[] = [];
  const rows = [...(options.rows ?? [])];
  const repository: AgentAppConfigRepository = {
    async placement(agentId) {
      if (agentId !== agent.id) return undefined;
      return {
        workspaceId: agent.workspaceId,
        computerId: options.computerId === undefined ? agent.computerId : options.computerId,
      };
    },
    async list(agentId) {
      return agentId === agent.id ? rows.map((row) => ({ ...row })) : [];
    },
    async get(agentId, appId) {
      const row = agentId === agent.id ? rows.find((item) => item.appId === appId) : undefined;
      return row && { ...row };
    },
    async write(agentId, appId, expectedRevision, config) {
      if (agentId !== agent.id) return false;
      const index = rows.findIndex((row) => row.appId === appId);
      if ((rows[index]?.revision ?? 0) !== expectedRevision) return false;
      const row = { appId, revision: expectedRevision + 1, config };
      if (index < 0) rows.push(row);
      else rows[index] = row;
      return true;
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
  return { configs, published, rows };
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

test("an Agent reads an App's schema, defaults, overrides and effective config", async () => {
  expect(await harness().configs.view(agent.id, CLEANER_APP_ID)).toEqual({
    state: "found",
    config: {
      appId: CLEANER_APP_ID,
      revision: 0,
      schema: cleanerSchema,
      defaults: cleanerDefaults,
      overrides: {},
      effective: cleanerDefaults,
    },
  });
  const partial = { appId: CLEANER_APP_ID, revision: 2, config: { threshold_bytes: 8_192 } };
  expect(await harness({ rows: [partial] }).configs.view(agent.id, CLEANER_APP_ID)).toMatchObject({
    config: { revision: 2, overrides: { threshold_bytes: 8_192 }, effective: cleanerDefaults },
  });
  expect(await harness().configs.view(agent.id, "system.unknown")).toEqual({
    state: "app_not_found",
  });
});

test("a change at the current revision is stored, raises the revision and reaches the daemon", async () => {
  const { configs, published, rows } = harness();
  const outcome = await configs.update(agent.id, CLEANER_APP_ID, {
    expectedRevision: 0,
    set: { threshold_bytes: 131_072, enabled: false },
    unset: [],
  });
  expect(outcome).toMatchObject({
    state: "updated",
    config: {
      revision: 1,
      overrides: { threshold_bytes: 131_072, enabled: false },
      effective: { enabled: false, threshold_bytes: 131_072, interval_seconds: 3600 },
    },
  });
  expect(rows).toEqual([
    { appId: CLEANER_APP_ID, revision: 1, config: { threshold_bytes: 131_072, enabled: false } },
  ]);
  expect(published).toMatchObject([
    {
      operation: "upsert",
      configs: [
        {
          revision: 1,
          effective: { enabled: false, thresholdBytes: 131_072, intervalMs: 3_600_000 },
        },
      ],
    },
  ]);
});

test("unsetting a key returns it to its default and keeps the row at the next revision", async () => {
  const { configs, rows } = harness({ rows: [stored] });
  const outcome = await configs.update(agent.id, CLEANER_APP_ID, {
    expectedRevision: 4,
    set: {},
    unset: ["enabled", "threshold_bytes", "interval_seconds"],
  });
  expect(outcome).toMatchObject({
    state: "updated",
    config: { revision: 5, overrides: {}, effective: cleanerDefaults },
  });
  expect(rows).toEqual([{ appId: CLEANER_APP_ID, revision: 5, config: {} }]);
});

test("a change made against an older revision is refused and changes nothing", async () => {
  const { configs, published, rows } = harness({ rows: [stored] });
  expect(
    await configs.update(agent.id, CLEANER_APP_ID, {
      expectedRevision: 3,
      set: { enabled: true },
      unset: [],
    }),
  ).toEqual({ state: "revision_conflict", revision: 4 });
  expect(rows).toEqual([stored]);
  expect(published).toEqual([]);
});

test("a change outside an App's schema is refused and changes nothing", async () => {
  for (const patch of [
    { set: { unknown_key: 1 }, unset: [] },
    { set: {}, unset: ["unknown_key"] },
    { set: { enabled: 1 }, unset: [] },
    { set: { threshold_bytes: true }, unset: [] },
    { set: { threshold_bytes: 4095 }, unset: [] },
    { set: { interval_seconds: 604_801 }, unset: [] },
    { set: { threshold_bytes: 8192.5 }, unset: [] },
    { set: { enabled: false }, unset: ["enabled"] },
  ]) {
    const { configs, rows } = harness();
    const outcome = await configs.update(agent.id, CLEANER_APP_ID, {
      expectedRevision: 0,
      ...patch,
    } as Parameters<typeof configs.update>[2]);
    expect(outcome.state).toBe("config_invalid");
    expect(rows).toEqual([]);
  }
  const { configs } = harness();
  expect(
    await configs.update(agent.id, "system.unknown", { expectedRevision: 0, set: {}, unset: [] }),
  ).toEqual({ state: "app_not_found" });
});

test("a stored row that no longer validates is read as the defaults at its revision", async () => {
  const broken = { appId: CLEANER_APP_ID, revision: 7, config: { threshold_bytes: 1 } };
  const { configs } = harness({ rows: [broken] });
  const sync = decodeAppConfigSync(await configs.snapshotForDaemon(request));
  expect(sync.configs).toMatchObject([{ revision: 7, effective: CLEANER_CONFIG_DEFAULTS }]);
  expect(await configs.view(agent.id, CLEANER_APP_ID)).toMatchObject({
    config: { revision: 7, overrides: {}, effective: cleanerDefaults },
  });
});
