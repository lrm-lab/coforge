import { expect, test } from "bun:test";
import { decodeAgentMigrationCancel, decodeAgentMigrationLease } from "@lrm/coforge-sdk/internal";
import { AgentMigrations } from "#src/server/agent-migrations/agent-migrations.server";
import {
  AGENT_MIGRATION_LEASE_MS,
  AgentMigrationDispatch,
  startAgentMigration,
} from "#src/server/agent-migrations/agent-migration-dispatch.server";
import { memoryStore } from "./helpers/agent-migration-memory-store";

const workspaceId = "workspace-1";

function publisher() {
  const published: { channel: string; data: Uint8Array }[] = [];
  return {
    published,
    api: {
      publish: async (channel: string, data: Uint8Array) => {
        published.push({ channel, data });
      },
    },
  };
}

const request = {
  workspaceId,
  agentId: "agent-1",
  targetComputerId: "computer-b",
  requestedByUserId: "user-1",
};

test("starting a migration leases the source Computer to stop the Agent and upload", async () => {
  const { api, published } = publisher();
  const migrations = new AgentMigrations(memoryStore().store);
  const started = await startAgentMigration(
    { migrations, dispatch: new AgentMigrationDispatch(api) },
    request,
  );
  if (started.status !== "created") throw new Error(started.status);
  expect(published.map((entry) => entry.channel)).toEqual([`daemon:${workspaceId}:computer-a`]);
  expect(decodeAgentMigrationLease(published[0]!.data)).toMatchObject({
    workspaceId,
    computerId: "computer-a",
    agentId: "agent-1",
    migrationId: started.migration.id,
    generation: 1,
    role: "source",
    expectedRevision: started.migration.revision,
    expiresInMs: AGENT_MIGRATION_LEASE_MS,
  });
});

test("a refused request leases nobody", async () => {
  const { api, published } = publisher();
  const migrations = new AgentMigrations(memoryStore().store);
  const dispatch = new AgentMigrationDispatch(api);
  await startAgentMigration({ migrations, dispatch }, request);
  published.length = 0;
  expect(await startAgentMigration({ migrations, dispatch }, request)).toMatchObject({
    status: "refused",
    code: "already_migrating",
  });
  expect(published).toEqual([]);
});

test("a cancel reaches both Computers, saying whether the Agent had already switched", async () => {
  const { api, published } = publisher();
  const migrations = new AgentMigrations(memoryStore().store);
  const created = await migrations.request(request);
  if (created.status !== "created") throw new Error(created.status);
  await new AgentMigrationDispatch(api).cancel(created.migration);
  expect(published.map((entry) => entry.channel)).toEqual([
    `daemon:${workspaceId}:computer-a`,
    `daemon:${workspaceId}:computer-b`,
  ]);
  expect(published.map((entry) => decodeAgentMigrationCancel(entry.data))).toMatchObject([
    { role: "source", switched: false, migrationId: created.migration.id },
    { role: "target", switched: false, migrationId: created.migration.id },
  ]);
});

test("a cancel still reaches the target when publishing to the source fails", async () => {
  const channels: string[] = [];
  const dispatch = new AgentMigrationDispatch({
    publish: async (channel) => {
      channels.push(channel);
      if (channel.endsWith("computer-a")) throw new Error("source unreachable");
    },
  });
  const migrations = new AgentMigrations(memoryStore().store);
  const created = await migrations.request(request);
  if (created.status !== "created") throw new Error(created.status);
  await expect(dispatch.cancel(created.migration)).rejects.toThrow("source unreachable");
  expect(channels).toEqual([
    `daemon:${workspaceId}:computer-a`,
    `daemon:${workspaceId}:computer-b`,
  ]);
});

test("a Computer that reconnects is leased again for the part each active migration needs of it", async () => {
  const { api, published } = publisher();
  const fixture = memoryStore();
  const migrations = new AgentMigrations(fixture.store);
  const dispatch = new AgentMigrationDispatch(api);
  const waiting = await migrations.request(request);
  const uploaded = await migrations.request({ ...request, agentId: "agent-2" });
  if (waiting.status !== "created" || uploaded.status !== "created") throw new Error("setup");
  const source = { workspaceId, computerId: "computer-a" };
  await migrations.advance(source, {
    migrationId: uploaded.migration.id,
    generation: 1,
    expectedRevision: 0,
    step: "source_stopped",
  });
  await migrations.advance(source, {
    migrationId: uploaded.migration.id,
    generation: 1,
    expectedRevision: 1,
    step: "upload_complete",
    manifest: {},
  });
  await dispatch.reissue(migrations, workspaceId, "computer-a");
  expect(published.map((entry) => decodeAgentMigrationLease(entry.data))).toMatchObject([
    { migrationId: waiting.migration.id, role: "source", computerId: "computer-a" },
  ]);
  published.length = 0;
  await dispatch.reissue(migrations, workspaceId, "computer-b");
  expect(published.map((entry) => decodeAgentMigrationLease(entry.data))).toMatchObject([
    { migrationId: uploaded.migration.id, role: "target", expectedRevision: 2 },
  ]);
});

test("reissuing a failed lease still attempts the Computer's other active migrations", async () => {
  const migrations = new AgentMigrations(memoryStore().store);
  const first = await migrations.request(request);
  const second = await migrations.request({ ...request, agentId: "agent-2" });
  if (first.status !== "created" || second.status !== "created") throw new Error("setup");
  const attempted: string[] = [];
  const dispatch = new AgentMigrationDispatch({
    publish: async (_channel, data) => {
      const lease = decodeAgentMigrationLease(data);
      attempted.push(lease.migrationId);
      if (lease.migrationId === first.migration.id) throw new Error("first lease failed");
    },
  });
  await expect(dispatch.reissue(migrations, workspaceId, "computer-a")).rejects.toThrow(
    "first lease failed",
  );
  expect(attempted).toEqual([first.migration.id, second.migration.id]);
});
