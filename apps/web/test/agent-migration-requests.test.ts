import { expect, test } from "bun:test";
import { AgentMigrations } from "#src/server/agent-migrations/agent-migrations.server";
import { AgentMigrationRequests } from "#src/server/agent-migrations/agent-migration-requests.server";
import { AgentMigrationSourceStopError } from "#src/server/agent-migrations/agent-migration-orchestrator.server";
import { memoryStore } from "./helpers/agent-migration-memory-store";

const owner = { userId: "user-1", workspaceId: "workspace-1" };
const stranger = { userId: "user-2", workspaceId: "workspace-1" };
const admin = { userId: "user-3", workspaceId: "workspace-1" };

function setup(options: { available?: boolean; fails?: "stop" | "lease" } = {}) {
  const fixture = memoryStore();
  const migrations = new AgentMigrations(fixture.store);
  const requested: string[] = [];
  const requests = new AgentMigrationRequests({
    migrations,
    orchestrator: {
      request: async (input) => {
        if (options.fails === "stop")
          throw new AgentMigrationSourceStopError(new Error("no answer"));
        if (options.fails === "lease") throw new Error("centrifugo is unreachable");
        requested.push(input.targetComputerId);
        return migrations.request(input);
      },
      cancel: (input) => migrations.cancel(input),
    },
    agentOwner: async (_workspaceId, agentId) => (agentId === "agent-1" ? "user-1" : undefined),
    isWorkspaceAdmin: async (_workspaceId, userId) => userId === "user-3",
    computerName: async (computerId) => (computerId === "computer-b" ? "Studio Mac" : null),
    available: async () => options.available ?? true,
  });
  return { requests, requested, fixture };
}

test("the owner moves the Agent; the owner and Workspace admins see the move, nobody else", async () => {
  const { requests, requested } = setup();
  expect(await requests.status(owner, "agent-1")).toEqual({ available: true, migration: null });
  const moved = await requests.request(owner, {
    agentId: "agent-1",
    targetComputerId: "computer-b",
  });
  expect(requested).toEqual(["computer-b"]);
  for (const viewer of [owner, admin])
    expect(await requests.status(viewer, "agent-1")).toMatchObject({
      available: true,
      migration: {
        id: moved.id,
        state: "requested",
        targetComputerId: "computer-b",
        targetComputerName: "Studio Mac",
        errorCode: null,
      },
    });
  // A private Agent's very existence stays hidden from other members.
  await expect(requests.status(stranger, "agent-1")).rejects.toMatchObject({ code: "NOT_FOUND" });
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
    setup({ fails: "stop" }).requests.request(owner, {
      agentId: "agent-1",
      targetComputerId: "computer-b",
    }),
  ).rejects.toMatchObject({
    code: "TEMPORARILY_UNAVAILABLE",
    errorId: "agent-migration-source-unreachable",
  });
});

test("a failure after the source stopped is not reported as a source that never answered", async () => {
  await expect(
    setup({ fails: "lease" }).requests.request(owner, {
      agentId: "agent-1",
      targetComputerId: "computer-b",
    }),
  ).rejects.toThrow("centrifugo is unreachable");
});
