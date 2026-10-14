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

/**
 * The pool's sessions run with JIT off, whatever the server's default, so no short read pays for
 * an LLVM compile its cost estimate happened to trigger. A query planned with `jit_above_cost` at
 * 0, which JIT-compiles anything when JIT is on, still has no JIT section in its plan.
 */
test.skipIf(!connectionString)("the pool's sessions plan without JIT", async () => {
  const db = new PrismaClient({ adapter: new PrismaPg(databasePoolConfig(connectionString!)) });
  try {
    const [plan] = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL jit_above_cost = 0`;
      return tx.$queryRaw<[{ "QUERY PLAN": [Record<string, unknown>] }]>`
        EXPLAIN (ANALYZE, FORMAT JSON) SELECT count(*) FROM generate_series(1, 1000)`;
    });
    expect(plan["QUERY PLAN"][0]).not.toHaveProperty("JIT");
    expect((await db.$queryRaw<[{ jit: string }]>`SHOW jit`)[0].jit).toBe("off");
  } finally {
    await db.$disconnect();
  }
});
