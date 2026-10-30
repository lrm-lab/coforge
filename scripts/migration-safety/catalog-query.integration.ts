// Not part of `mise run test`: run by path against a scratch PostgreSQL, e.g.
// `MIGRATION_SAFETY_ADMIN_URL=postgresql://coforge:test@localhost:15458/postgres
// bun test ./scripts/migration-safety/catalog-query.integration.ts`.
// A partitioned parent holds no data itself: the snapshot must report its partitions' size.
import { SQL } from "bun";
import { afterAll, expect, test } from "bun:test";
import { liveSource } from "./catalog-query";

const adminUrl =
  process.env.MIGRATION_SAFETY_ADMIN_URL ?? "postgresql://coforge:test@localhost:15458/postgres";
const name = `cq_${process.pid}`;
const admin = new SQL(adminUrl);
afterAll(async () => {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.close();
});

test("a partitioned table is the sum of its partitions, a plain table is itself", async () => {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const db = new SQL(url.toString());
  await db.unsafe(`
    CREATE TABLE parent (id int, pad text) PARTITION BY RANGE (id);
    CREATE TABLE part_a PARTITION OF parent FOR VALUES FROM (0) TO (1000);
    CREATE TABLE part_b PARTITION OF parent FOR VALUES FROM (1000) TO (2000);
    INSERT INTO parent SELECT g, repeat('x', 100) FROM generate_series(0, 1999) g;
    CREATE TABLE plain (id int);
    ANALYZE`);
  await db.close();

  const source = liveSource(url.toString());
  try {
    const byName = new Map((await source.tables()).map((table) => [table.name, table]));
    expect(byName.get("parent")!.approxRows).toBe(2000);
    expect(byName.get("parent")!.totalBytes).toBe(
      byName.get("part_a")!.totalBytes + byName.get("part_b")!.totalBytes,
    );
    expect(byName.get("parent")!.totalBytes).toBeGreaterThan(0);
    // Never analysed and empty: no row estimate (-1) and no bytes, so it is small.
    expect(byName.get("plain")).toMatchObject({ approxRows: -1, totalBytes: 0 });
  } finally {
    await source.close();
  }
});
