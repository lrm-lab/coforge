import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  readPlatformMemoryPreference,
  savePlatformMemoryPreference,
} from "#src/server/db/repositories/platform-memory-preferences.repositories.server";
import { PrismaPlatformMemoryStore } from "#src/server/db/repositories/platform-memory.repositories.server";
import { platformMemoryEnabled } from "#src/server/platform-memory/activation.server";

const url = Bun.env.PLATFORM_MEMORY_TEST_DATABASE_URL;
if (!url)
  throw new Error(
    "PLATFORM_MEMORY_TEST_DATABASE_URL must name a disposable, migrated PostgreSQL database",
  );
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
const users: string[] = [];
const workspaces: string[] = [];
const agents: { id: string; workspaceId: string; ownerId: string }[] = [];

beforeAll(async () => {
  for (const name of ["owner", "other"])
    users.push(
      (
        await db.user.create({
          data: { username: `memory-switch-${name}-${crypto.randomUUID()}`, displayName: name },
        })
      ).id,
    );
  for (let i = 0; i < 2; i++) {
    const workspace = await db.workspace.create({
      data: {
        slug: `memory-switch-${crypto.randomUUID()}`,
        name: "Memory switch fixture",
        members: { create: users.map((userId) => ({ userId, role: "member" })) },
      },
    });
    workspaces.push(workspace.id);
    for (const ownerId of users)
      agents.push(
        await db.agent.create({
          data: {
            workspaceId: workspace.id,
            ownerId,
            name: `fixture-${ownerId}`,
            displayName: "Fixture",
            runtimeConfig: { runtime: "codex" },
          },
          select: { id: true, ownerId: true, workspaceId: true },
        }),
      );
  }
});
afterAll(async () => {
  await db.workspace.deleteMany({ where: { id: { in: workspaces } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

test("personal choice persists without overwriting other preferences and covers owned Agents in every Workspace", async () => {
  const userId = users[0]!;
  expect(await readPlatformMemoryPreference(db, userId)).toBe(true);
  await db.userPreference.create({ data: { userId, language: "en" } });
  expect(await readPlatformMemoryPreference(db, userId)).toBe(true);
  await savePlatformMemoryPreference(db, userId, false);
  expect((await db.userPreference.findUniqueOrThrow({ where: { userId } })).language).toBe("en");
  const store = new PrismaPlatformMemoryStore(db);
  for (const agent of agents) {
    const expected = agent.ownerId !== userId;
    expect(
      (await store.access({ kind: "agent", workspaceId: agent.workspaceId, agentId: agent.id }))
        .enabled,
    ).toBe(expected);
    expect(
      await platformMemoryEnabled(db, { workspaceId: agent.workspaceId, ownerId: agent.ownerId }),
    ).toBe(expected);
  }
  expect((await store.access({ kind: "user", workspaceId: workspaces[0]!, userId })).enabled).toBe(
    true,
  );
  await savePlatformMemoryPreference(db, userId, true);
  expect(await readPlatformMemoryPreference(db, userId)).toBe(true);
});

test("the Workspace master switch overrides personal opt-in while leaving another Workspace enabled", async () => {
  await db.workspace.update({
    where: { id: workspaces[0]! },
    data: { experiments: { platformMemory: false } },
  });
  for (const agent of agents) {
    expect(
      await platformMemoryEnabled(db, { workspaceId: agent.workspaceId, ownerId: agent.ownerId }),
    ).toBe(agent.workspaceId !== workspaces[0]);
  }
});
