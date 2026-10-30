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

test("an experiment choice is stored per key on the Workspace, beside its other settings", async () => {
  const db = database();
  const workspace = await db.workspace.create({
    data: { slug: `exp-${crypto.randomUUID().slice(0, 8)}`, name: "Experiments" },
  });
  try {
    const repository = new PrismaExperimentsRepository(db);
    expect(await repository.read(workspace.id)).toEqual({});

    await repository.write(workspace.id, "taskConversations", true);
    await db.workspace.update({ where: { id: workspace.id }, data: { name: "Renamed" } });
    await repository.write(workspace.id, "other", false);
    await repository.write(workspace.id, "taskConversations", false);

    expect(await repository.read(workspace.id)).toEqual({ taskConversations: false, other: false });
    expect((await db.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).name).toBe(
      "Renamed",
    );
    expect(await repository.read(crypto.randomUUID())).toEqual({});
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.$disconnect();
  }
});
