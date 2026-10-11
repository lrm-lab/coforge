import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { databasePoolConfig } from "#src/server/db/client.server";

/**
 * The Web database pool keeps an idle connection past `pg`'s 10 s default, so a request after a
 * short lull reuses it instead of first opening a new one. The same backend answering before and
 * after an 11 s pause is that connection.
 */
const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

test.skipIf(!connectionString)(
  "a request after an 11 s lull reuses the pool's idle connection",
  async () => {
    const db = new PrismaClient({ adapter: new PrismaPg(databasePoolConfig(connectionString!)) });
    try {
      const backend = async () =>
        (await db.$queryRaw<[{ pid: number }]>`SELECT pg_backend_pid() AS pid`)[0].pid;
      const before = await backend();
      await Bun.sleep(11_000);
      expect(await backend()).toBe(before);
    } finally {
      await db.$disconnect();
    }
  },
  30_000,
);
