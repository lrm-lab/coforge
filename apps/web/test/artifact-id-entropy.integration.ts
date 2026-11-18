import { afterAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});
afterAll(() => db.$disconnect());

const LOW_42 = (1n << 42n) - 1n;
const GENERATED = 300;

test("ids Prisma's uuid(7) draws in one millisecond differ in their low 42 bits unpredictably", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const names = Array.from({ length: GENERATED }, (_, i) => ({
    username: `id-entropy-${tag}-${i}`,
    displayName: "x",
  }));
  const ids = await db
    .$transaction(async (tx) => {
      await tx.user.createMany({ data: names });
      const rows = await tx.user.findMany({
        where: { username: { startsWith: `id-entropy-${tag}` } },
        select: { id: true, username: true },
      });
      const order = new Map(names.map((name, i) => [name.username, i]));
      throw Object.assign(new Error("rollback"), {
        ids: rows.sort((a, b) => order.get(a.username)! - order.get(b.username)!).map((r) => r.id),
      });
    })
    .catch((error: { ids?: string[] }) => error.ids!);
  const parsed = ids.map((id) => BigInt(`0x${id.replaceAll("-", "")}`));
  const byMillisecond = new Map<bigint, bigint[]>();
  for (const value of parsed) {
    const key = value >> 80n;
    byMillisecond.set(key, [...(byMillisecond.get(key) ?? []), value]);
  }
  const group = [...byMillisecond.values()].sort((a, b) => b.length - a.length)[0]!;
  expect(group.length).toBeGreaterThan(20);
  const gaps = group.slice(1).map((value, i) => {
    const gap = (value & LOW_42) - (group[i]! & LOW_42);
    return gap < 0n ? -gap : gap;
  });
  expect(new Set(gaps).size).toBeGreaterThan(1);
  expect(gaps.reduce((a, b) => (a > b ? a : b))).toBeGreaterThan(1n << 32n);
});
