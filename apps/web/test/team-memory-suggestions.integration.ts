import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { teamMemory } from "#src/server/team-memory/composition.server";
import {
  listMemorySuggestions,
  reviewMemorySuggestion,
} from "#src/server/team-memory/suggestion-review.server";
import { scanTeamMemorySuggestions } from "#src/server/team-memory/suggestion-scan.server";

const connectionString = Bun.env.TEAM_MEMORY_TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEAM_MEMORY_TEST_DATABASE_URL is required");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
let workspaceId: string;
let userId: string;

beforeAll(async () => {
  const user = await db.user.create({
    data: { username: `memory-review-${crypto.randomUUID()}`, displayName: "Memory reviewer" },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `memory-review-${crypto.randomUUID()}`,
      name: "Memory review",
      members: { create: { userId, role: "owner" } },
    },
  });
  workspaceId = workspace.id;
});
afterAll(async () => {
  if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  if (userId) await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

test("manual scanning proposes a duplicate and concurrent reviewers commit it once", async () => {
  const actor = { workspaceId, userId };
  const memory = teamMemory(db);
  for (const title of ["Deployment result", "Rollout outcome"]) {
    const draft = {
      operation: "create" as const,
      requestId: crypto.randomUUID(),
      title,
      content: "The smoke checks passed for version 42.",
      source: "Workspace acceptance",
      kind: "fact" as const,
      applicability: "production",
    };
    const review = await memory.execute(actor, draft);
    await memory.execute(actor, { ...draft, reviewToken: review.reviewToken });
  }
  expect(await scanTeamMemorySuggestions(db, workspaceId, userId)).toMatchObject({
    inspected: 2,
    suggested: 1,
  });
  expect(await scanTeamMemorySuggestions(db, workspaceId, userId)).toMatchObject({
    inspected: 2,
    suggested: 0,
  });
  const { rows } = await listMemorySuggestions(db, actor);
  expect(rows).toHaveLength(1);
  const id = rows[0]!.id;
  const [first, second] = await Promise.all([
    reviewMemorySuggestion(db, actor, id, "accept"),
    reviewMemorySuggestion(db, actor, id, "accept"),
  ]);
  expect(first).toEqual(second);
  expect(first.status).toBe("accepted");
  expect((await memory.execute(actor, { operation: "list" })).entries).toHaveLength(1);
  expect((await memory.execute(actor, { operation: "list", archived: true })).entries).toHaveLength(
    1,
  );
  expect((await listMemorySuggestions(db, actor)).rows).toHaveLength(0);
});
