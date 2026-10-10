import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PROJECT_DETAIL_SELECT } from "#src/server/projects/project-detail.server";

if (!Bun.env.CHANNEL_TEST_DATABASE_URL)
  throw new Error("CHANNEL_TEST_DATABASE_URL must target disposable local PostgreSQL");
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: Bun.env.CHANNEL_TEST_DATABASE_URL }),
});
afterAll(() => db.$disconnect());

// Prisma validates a query's shape against the migrated schema before it reads a row, so an empty
// result is enough to prove the select names only fields that exist. A field dropped from the
// schema but still selected made every project page fail (`Unknown field` on `User`).
test("the project page's query is valid for the migrated schema", async () => {
  const project = await db.project.findFirst({
    where: { workspaceId: crypto.randomUUID(), slug: "no-such-project" },
    select: PROJECT_DETAIL_SELECT,
  });
  expect(project).toBeNull();
});
