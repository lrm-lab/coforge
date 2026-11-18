import { expect, test } from "bun:test";
import type { Prisma } from "#src/generated/prisma/client";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import {
  database,
  seedAgentOnComputer,
  seedWorkspace,
  startingState,
} from "./helpers/agent-control-integration";

const seedAgent = (
  db: ReturnType<typeof database>,
  base: Awaited<ReturnType<typeof seedWorkspace>>,
  name: string,
  controlState: Prisma.InputJsonObject | null,
  deletedAt: Date | null = null,
) =>
  seedAgentOnComputer(db, base, {
    name,
    deletedAt,
    ...(controlState ? { state: (agent) => startingState(agent, `r-${name}`, controlState) } : {}),
  });

test("only starting Agents whose deadline has passed, or that never recorded one, are listed", async () => {
  const db = database();
  const base = await seedWorkspace(db);
  const NOW = 2_000_000_000_000;
  const expired = await seedAgent(db, base, "expired", {
    phase: "starting",
    deadlineAtMs: NOW - 1,
  });
  const atDeadline = await seedAgent(db, base, "at-deadline", {
    phase: "starting",
    deadlineAtMs: NOW,
  });
  const legacy = await seedAgent(db, base, "legacy", { phase: "starting" });
  const future = await seedAgent(db, base, "future", { phase: "starting", deadlineAtMs: NOW + 1 });
  const completed = await seedAgent(db, base, "completed", {
    phase: "completed",
    deadlineAtMs: NOW - 1,
  });
  const failed = await seedAgent(db, base, "failed", { phase: "failed", deadlineAtMs: NOW - 1 });
  const deleted = await seedAgent(
    db,
    base,
    "deleted",
    { phase: "starting", deadlineAtMs: NOW - 1 },
    new Date(),
  );
  const never = await seedAgent(db, base, "never", null);

  const found = new Set<string>();
  const store = new PrismaAgentControlStore(db);
  let cursor: Awaited<ReturnType<typeof store.listStartupCandidates>>["next"];
  do {
    const page = await store.listStartupCandidates(NOW, 1000, cursor);
    page.ids.forEach((id) => found.add(id));
    cursor = page.next;
  } while (cursor);

  expect(found.has(expired.id)).toBe(true);
  expect(found.has(atDeadline.id)).toBe(true);
  expect(found.has(legacy.id)).toBe(true);
  for (const agent of [future, completed, failed, deleted, never])
    expect(found.has(agent.id)).toBe(false);
  for (const id of found) expect(await store.get(id)).toBeDefined();
});

test("an Agent whose owner left the Workspace or whose Computer is unlinked is never a candidate", async () => {
  const db = database();
  const NOW = 2_000_000_000_000;
  const leftBase = await seedWorkspace(db);
  const left = await seedAgent(db, leftBase, "left", { phase: "starting", deadlineAtMs: NOW - 1 });
  await db.workspaceMembership.delete({
    where: {
      workspaceId_userId: { workspaceId: leftBase.workspace.id, userId: leftBase.owner.id },
    },
  });
  const unlinkedBase = await seedWorkspace(db);
  const unlinked = await seedAgent(db, unlinkedBase, "unlinked", {
    phase: "starting",
    deadlineAtMs: NOW - 1,
  });
  await db.workspaceComputer.delete({
    where: {
      workspaceId_computerId: {
        workspaceId: unlinkedBase.workspace.id,
        computerId: unlinkedBase.computer.id,
      },
    },
  });

  const found = new Set<string>();
  const store = new PrismaAgentControlStore(db);
  let cursor: Awaited<ReturnType<typeof store.listStartupCandidates>>["next"];
  do {
    const page = await store.listStartupCandidates(NOW, 1000, cursor);
    page.ids.forEach((id) => found.add(id));
    cursor = page.next;
  } while (cursor);

  expect(found.has(left.id)).toBe(false);
  expect(found.has(unlinked.id)).toBe(false);
});

test("a small batch walks every candidate exactly once through the cursor", async () => {
  const db = database();
  const base = await seedWorkspace(db);
  const NOW = 2_000_000_000_000;
  const seeded = new Set<string>();
  for (let index = 0; index < 5; index++) {
    const agent = await seedAgent(db, base, `walk-${index}`, {
      phase: "starting",
      deadlineAtMs: NOW - 10 + (index % 2),
    });
    seeded.add(agent.id);
  }
  const store = new PrismaAgentControlStore(db);
  const seen: string[] = [];
  let cursor: Awaited<ReturnType<typeof store.listStartupCandidates>>["next"];
  do {
    const page = await store.listStartupCandidates(NOW, 2, cursor);
    seen.push(...page.ids.filter((id) => seeded.has(id)));
    cursor = page.next;
  } while (cursor);
  expect(new Set(seen).size).toBe(5);
  expect(seen).toHaveLength(5);
});
