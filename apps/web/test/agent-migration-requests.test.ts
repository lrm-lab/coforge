import { expect, test } from "bun:test";
import { AgentMigrations } from "#src/server/agent-migrations/agent-migrations.server";
import { AgentMigrationRequests } from "#src/server/agent-migrations/agent-migration-requests.server";
import { memoryStore } from "./helpers/agent-migration-memory-store";

const owner = { userId: "user-1", workspaceId: "workspace-1" };
const stranger = { userId: "user-2", workspaceId: "workspace-1" };

function setup(options: { available?: boolean; stopFails?: boolean } = {}) {
  const fixture = memoryStore();
  const migrations = new AgentMigrations(fixture.store);
  const requested: string[] = [];
  const requests = new AgentMigrationRequests({
    migrations,
    orchestrator: {
      request: async (input) => {
        if (options.stopFails) throw new Error("the source did not confirm the stop");
        requested.push(input.targetComputerId);
        return migrations.request(input);
      },
      cancel: (input) => migrations.cancel(input),
    },
    agentOwner: async (_workspaceId, agentId) => (agentId === "agent-1" ? "user-1" : undefined),
    available: async () => options.available ?? true,
  });
  return { requests, requested, fixture };
}

test("the owner moves the Agent, and anyone in the Workspace sees how the move is going", async () => {
  const { requests, requested } = setup();
  expect(await requests.status(stranger, "agent-1")).toEqual({ available: true, migration: null });
  const moved = await requests.request(owner, {
    agentId: "agent-1",
    targetComputerId: "computer-b",
  });
  expect(requested).toEqual(["computer-b"]);
  expect(await requests.status(stranger, "agent-1")).toMatchObject({
    available: true,
    migration: {
      id: moved.id,
      state: "requested",
      targetComputerId: "computer-b",
      errorCode: null,
    },
  });
});

test("only the owner may move or cancel, and each refusal names its reason", async () => {
  const { requests } = setup();
  const move = (input: { agentId?: string; targetComputerId: string }, who = owner) =>
    requests.request(who, { agentId: "agent-1", ...input });
  await expect(move({ targetComputerId: "computer-b" }, stranger)).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  await expect(move({ targetComputerId: "computer-a" })).rejects.toMatchObject({
    code: "INVALID_INPUT",
    errorId: "agent-migration-same-computer",
  });
  await expect(move({ targetComputerId: "computer-z" })).rejects.toMatchObject({
    code: "INVALID_INPUT",
    errorId: "agent-migration-target-unavailable",
  });
  const moved = await move({ targetComputerId: "computer-b" });
  await expect(move({ targetComputerId: "computer-b" })).rejects.toMatchObject({
    code: "CONFLICT",
    errorId: "agent-migrating",
  });
  await expect(
    requests.cancel(stranger, { agentId: "agent-1", migrationId: moved.id }),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  await requests.cancel(owner, { agentId: "agent-1", migrationId: moved.id });
  expect(await requests.status(owner, "agent-1")).toMatchObject({
    migration: { state: "canceled" },
  });
  // A second cancel of a migration that already ended is not an error.
  await requests.cancel(owner, { agentId: "agent-1", migrationId: moved.id });
});

test("a deployment without the migration bucket, or a source that cannot stop, refuses up front", async () => {
  await expect(
    setup({ available: false }).requests.request(owner, {
      agentId: "agent-1",
      targetComputerId: "computer-b",
    }),
  ).rejects.toMatchObject({
    code: "TEMPORARILY_UNAVAILABLE",
    errorId: "agent-migration-unavailable",
  });
  expect(await setup({ available: false }).requests.status(owner, "agent-1")).toMatchObject({
    available: false,
  });
  await expect(
    setup({ stopFails: true }).requests.request(owner, {
      agentId: "agent-1",
      targetComputerId: "computer-b",
    }),
  ).rejects.toMatchObject({
    code: "TEMPORARILY_UNAVAILABLE",
    errorId: "agent-migration-source-unreachable",
  });
});
