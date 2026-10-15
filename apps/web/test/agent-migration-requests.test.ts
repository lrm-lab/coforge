import { expect, test } from "bun:test";
import { AgentMigrations } from "#src/server/agent-migrations/agent-migrations.server";
import { AgentMigrationRequests } from "#src/server/agent-migrations/agent-migration-requests.server";
import { AgentMigrationSourceStopError } from "#src/server/agent-migrations/agent-migration-orchestrator.server";
import { storedRuntimeSelection } from "#src/server/agents/computer-runtime-availability.server";
import { memoryStore } from "./helpers/agent-migration-memory-store";

const owner = { userId: "user-1", workspaceId: "workspace-1" };
const stranger = { userId: "user-2", workspaceId: "workspace-1" };
const admin = { userId: "user-3", workspaceId: "workspace-1" };

type Readiness = "ready" | "offline" | "outdated";

function setup(
  options: {
    available?: boolean;
    fails?: "stop" | "lease";
    runtimeMissing?: boolean;
    readiness?: Record<string, Readiness>;
  } = {},
) {
  const fixture = memoryStore();
  const migrations = new AgentMigrations(fixture.store);
  const requested: string[] = [];
  const requests = new AgentMigrationRequests({
    migrations,
    orchestrator: () => ({
      request: async (input) => {
        if (options.fails === "stop")
          throw new AgentMigrationSourceStopError(new Error("no answer"));
        if (options.fails === "lease") throw new Error("centrifugo is unreachable");
        requested.push(input.targetComputerId);
        return migrations.request(input);
      },
      cancel: (input) => migrations.cancel(input),
    }),
    agentOwner: async (_workspaceId, agentId) => (agentId === "agent-1" ? "user-1" : undefined),
    isWorkspaceAdmin: async (_workspaceId, userId) => userId === "user-3",
    computerName: async (computerId) =>
      ({ "computer-a": "Computer A", "computer-b": "Studio Mac" })[computerId] ?? null,
    canRunAgent: async () => !options.runtimeMissing,
    agentComputer: async () => "computer-a",
    computerReadiness: async (_workspaceId, computerId) =>
      options.readiness?.[computerId] ?? "ready",
    otherComputers: async () => [
      { id: "computer-b", name: "Studio Mac" },
      { id: "computer-c", name: "Old Laptop" },
    ],
    available: async () => options.available ?? true,
  });
  return { requests, requested, fixture };
}

test("the owner moves the Agent; the owner and Workspace admins see the move, nobody else", async () => {
  const { requests, requested } = setup();
  expect(await requests.status(owner, "agent-1")).toEqual({
    available: true,
    migration: null,
  });
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
        sourceComputerName: "Computer A",
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

test("a Computer that cannot run the Agent's runtime is refused before anything stops", async () => {
  const { requests, requested } = setup({ runtimeMissing: true });
  await expect(
    requests.request(owner, { agentId: "agent-1", targetComputerId: "computer-b" }),
  ).rejects.toMatchObject({
    code: "INVALID_INPUT",
    errorId: "agent-migration-runtime-unavailable",
  });
  expect(requested).toEqual([]);
});

test("a move checks the target against the Agent's stored selection, key included", () => {
  const base = {
    runtime: "pi" as const,
    model: "claude-sonnet",
    modelProvider: "anthropic",
    reasoning: "high",
  };
  expect(storedRuntimeSelection({ ...base, provider: { kind: "default" } })).toEqual({
    provider: "pi",
    model: "claude-sonnet",
    modelProvider: "anthropic",
    reasoning: "high",
    hasApiKey: false,
  });
  expect(
    storedRuntimeSelection({
      ...base,
      provider: {
        kind: "coforge",
        providerId: "anthropic",
        apiKey: { keyId: "v1", ciphertext: "x", nonce: "n", hint: "••••1234" },
      },
    } as never).hasApiKey,
  ).toBe(true);
});

test("reading a move needs nothing it would take to start one", async () => {
  const fixture = memoryStore();
  const requests = new AgentMigrationRequests({
    migrations: new AgentMigrations(fixture.store),
    orchestrator: () => {
      throw new Error("Centrifugo server API is not configured");
    },
    agentOwner: async () => "user-1",
    isWorkspaceAdmin: async () => false,
    computerName: async () => null,
    canRunAgent: async () => true,
    agentComputer: async () => "computer-a",
    computerReadiness: async () => "ready",
    otherComputers: async () => [],
    available: async () => true,
  });
  expect(await requests.status(owner, "agent-1")).toEqual({
    available: true,
    migration: null,
  });
});

test("a Computer that is offline or too old to move Agents is refused before anything stops", async () => {
  for (const [readiness, errorId] of [
    [{ "computer-a": "outdated" }, "agent-migration-source-outdated"],
    [{ "computer-a": "offline" }, "agent-migration-source-offline"],
    [{ "computer-b": "outdated" }, "agent-migration-target-outdated"],
    [{ "computer-b": "offline" }, "agent-migration-target-offline"],
  ] as const) {
    const { requests, requested } = setup({ readiness });
    await expect(
      requests.request(owner, { agentId: "agent-1", targetComputerId: "computer-b" }),
    ).rejects.toMatchObject({ errorId });
    expect(requested).toEqual([]);
  }
});

test("the dialog lists every other Computer, ready or not; the request says which cannot take part", async () => {
  const { requests } = setup({
    readiness: { "computer-a": "outdated", "computer-c": "offline" },
    runtimeMissing: true,
  });
  expect(await requests.targets(owner, "agent-1")).toEqual([
    { id: "computer-b", name: "Studio Mac" },
    { id: "computer-c", name: "Old Laptop" },
  ]);
  await expect(requests.targets(stranger, "agent-1")).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
});
