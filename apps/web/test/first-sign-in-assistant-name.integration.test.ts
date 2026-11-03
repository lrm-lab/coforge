import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { completeFirstSignIn } from "#src/server/auth/first-sign-in.server";

/**
 * The assistant a first sign-in makes for the personal Workspace is named for the person in the
 * request's locale. Skipped unless `CHANNEL_TEST_DATABASE_URL` points at local PostgreSQL.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
const db = connectionString
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  : undefined;
const userIds: string[] = [];

afterAll(async () => {
  if (!db) return;
  await db.workspace.deleteMany({ where: { members: { some: { userId: { in: userIds } } } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

test.skipIf(!db)("the assistant carries the name in the language the sign-in carries", async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  for (const [locale, assistantName] of [
    ["zh-CN", `Ada${suffix}的助手`],
    ["en", `Ada${suffix}'s Assistant`],
  ] as const) {
    const user = await db!.user.create({
      data: { username: `fsn-${locale}-${suffix}`, displayName: `Ada${suffix}` },
    });
    userIds.push(user.id);
    await completeFirstSignIn({ db: db!, user, displayName: `Ada${suffix}`, locale });
    const agents = await db!.agent.findMany({
      where: { ownerId: user.id, systemKind: "workspace-assistant" },
      select: { displayName: true },
    });
    // The name stored first stays the person's name, and names the assistant.
    expect(agents.map((agent) => agent.displayName)).toEqual([assistantName]);
  }
});
