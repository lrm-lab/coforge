import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaPlatformMemoryStore } from "#src/server/db/repositories/platform-memory.repositories.server";

function store(choice: boolean | null, workspaceChoice?: boolean) {
  const db = {
    agent: {
      findFirst: async ({ where }: { where: { id: string } }) => ({
        ownerId: where.id === "agent-a" ? "user-a" : "user-b",
      }),
    },
    workspaceMembership: { findUnique: async () => ({ role: "member" }) },
    workspace: {
      findUnique: async () => ({
        experiments: workspaceChoice === undefined ? {} : { platformMemory: workspaceChoice },
      }),
    },
    userPreference: {
      findUnique: async ({ where }: { where: { userId: string } }) => ({
        platformMemoryEnabled: where.userId === "user-a" ? choice : true,
      }),
    },
  } as unknown as PrismaClient;
  return new PrismaPlatformMemoryStore(db);
}

test("an owner's opt-out blocks all of their Agents without disabling another owner's Agent", async () => {
  const memory = store(false, true);
  expect(
    (await memory.access({ kind: "agent", workspaceId: "workspace-a", agentId: "agent-a" }))
      .enabled,
  ).toBe(false);
  expect(
    (await memory.access({ kind: "agent", workspaceId: "workspace-b", agentId: "agent-a" }))
      .enabled,
  ).toBe(false);
  expect(
    (await memory.access({ kind: "agent", workspaceId: "workspace-a", agentId: "agent-b" }))
      .enabled,
  ).toBe(true);
});

test("an unset personal and Workspace switch default to enabled", async () => {
  expect(
    (await store(null).access({ kind: "agent", workspaceId: "workspace-a", agentId: "agent-a" }))
      .enabled,
  ).toBe(true);
});

test("the Workspace master switch overrides an owner's enabled choice", async () => {
  expect(
    (
      await store(true, false).access({
        kind: "agent",
        workspaceId: "workspace-a",
        agentId: "agent-a",
      })
    ).enabled,
  ).toBe(false);
});
