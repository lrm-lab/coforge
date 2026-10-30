import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";

function database() {
  const connectionString = Bun.env.PREFERENCES_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("PREFERENCES_TEST_DATABASE_URL must point to local PostgreSQL");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

test("an experiment choice is stored per key, beside the user's other preferences", async () => {
  const db = database();
  const user = await db.user.create({
    data: { displayName: `exp-${crypto.randomUUID()}`, username: `exp-${crypto.randomUUID()}` },
  });
  try {
    const repository = new PrismaExperimentsRepository(db);
    expect(await repository.read(user.id)).toEqual({});

    await repository.write(user.id, "taskConversations", true);
    await db.userPreference.update({
      where: { userId: user.id },
      data: { timeZone: "Asia/Tokyo" },
    });
    await repository.write(user.id, "other", false);
    await repository.write(user.id, "taskConversations", false);

    expect(await repository.read(user.id)).toEqual({ taskConversations: false, other: false });
    expect(
      (await db.userPreference.findUniqueOrThrow({ where: { userId: user.id } })).timeZone,
    ).toBe("Asia/Tokyo");
  } finally {
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
});
