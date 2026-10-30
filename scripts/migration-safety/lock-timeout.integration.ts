// Not part of `mise run test` (bun discovers only *.test.* files): run it by path against a scratch
// PostgreSQL 18, e.g. `MIGRATION_SAFETY_ADMIN_URL=postgresql://coforge:test@localhost:15458/postgres
// bun test ./scripts/migration-safety/lock-timeout.integration.ts`.
//
// Question it settles: which form of lock_timeout makes `prisma migrate deploy` give up on a
// blocked migration, `SET lock_timeout` or `SET LOCAL lock_timeout`? Each case holds a conflicting
// lock from another connection, then runs the real `migrate deploy` over a migration that sets the
// timeout and takes ACCESS EXCLUSIVE, and records whether it failed at the timeout.
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const adminUrl =
  process.env.MIGRATION_SAFETY_ADMIN_URL ?? "postgresql://coforge:test@localhost:15458/postgres";
const prismaCli = join(import.meta.dir, "../../apps/web/node_modules/prisma/build/index.js");

const admin = new SQL(adminUrl);
const scratch = mkdtempSync(join(tmpdir(), "lock-timeout-"));

function databaseUrl(name: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function writeProject(dir: string, migrations: Record<string, string>) {
  mkdirSync(join(dir, "prisma/migrations"), { recursive: true });
  writeFileSync(
    join(dir, "prisma.config.ts"),
    'export default { schema: "prisma", migrations: { path: "prisma/migrations" }, datasource: { url: process.env.DATABASE_URL } };\n',
  );
  writeFileSync(
    join(dir, "prisma/schema.prisma"),
    'datasource db {\n  provider = "postgresql"\n}\n',
  );
  writeFileSync(join(dir, "prisma/migrations/migration_lock.toml"), 'provider = "postgresql"\n');
  for (const [name, sql] of Object.entries(migrations)) {
    mkdirSync(join(dir, "prisma/migrations", name), { recursive: true });
    writeFileSync(join(dir, "prisma/migrations", name, "migration.sql"), sql);
  }
}

async function migrateDeploy(dir: string, url: string, killAfterMs: number) {
  const started = Date.now();
  const proc = Bun.spawn(["bun", prismaCli, "migrate", "deploy"], {
    cwd: dir,
    env: { ...process.env, DATABASE_URL: url },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), killAfterMs);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const elapsed = Date.now() - started;
  return { output: out + err, code, seconds: elapsed / 1000, killed: elapsed >= killAfterMs };
}

/** Runs `migration` (the second migration file) while another connection holds ACCESS SHARE on `big`. */
async function runBlocked(label: string, migration: string, killAfterMs = 30_000) {
  const name = `lt_${label}_${process.pid}`;
  await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = databaseUrl(name);
  const dir = join(scratch, label);
  const base = { "20260101000000_base": "CREATE TABLE big (id int);\n" };
  writeProject(dir, base);
  expect((await migrateDeploy(dir, url, 60_000)).code).toBe(0);
  writeProject(dir, { ...base, "20260102000000_alter": migration });
  const blocker = new SQL(url, { max: 1 });
  const held = await blocker.reserve();
  await held.unsafe("BEGIN");
  await held.unsafe("LOCK TABLE big IN ACCESS SHARE MODE");
  try {
    return await migrateDeploy(dir, url, killAfterMs);
  } finally {
    await held.unsafe("ROLLBACK");
    held.release();
    await blocker.close();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
}

const alter = "ALTER TABLE big ADD COLUMN x int;\n";

describe("lock_timeout in a Prisma migration file", () => {
  beforeAll(async () => {
    const [{ version }] = await admin`SELECT version()`;
    expect(version).toContain("PostgreSQL 18");
  });
  afterAll(async () => {
    rmSync(scratch, { recursive: true, force: true });
    await admin.close();
  });

  test("control: without lock_timeout the migration waits for the lock", async () => {
    const result = await runBlocked("none", alter, 8_000);
    expect(result.killed).toBe(true);
  }, 60_000);

  test("SET LOCAL lock_timeout does NOT stop the migration waiting", async () => {
    const result = await runBlocked("local", `SET LOCAL lock_timeout = '2s';\n${alter}`, 10_000);
    // Prisma sends the file outside a transaction block, so SET LOCAL has no effect (and warns).
    expect(result.killed).toBe(true);
  }, 90_000);

  test("SET lock_timeout fails the migration at the timeout (session level)", async () => {
    const result = await runBlocked("session", `SET lock_timeout = '2s';\n${alter}`);
    expect(result.killed).toBe(false);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("lock timeout");
  }, 90_000);

  test.each([
    ["without RESET the next migration file still has it", "", "3s"],
    ["after RESET the next migration file is back to the default", "RESET lock_timeout;\n", "0"],
  ])(
    "a session-level SET carries over: %s",
    async (_label, reset, expected) => {
      const name = `lt_leak_${process.pid}`;
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE ${name}`);
      const url = databaseUrl(name);
      const dir = join(scratch, `leak-${expected}`);
      writeProject(dir, {
        "20260101000000_set": `SET lock_timeout = '3s';\nCREATE TABLE a (id int);\n${reset}`,
        "20260103000000_read":
          "CREATE TABLE seen AS SELECT current_setting('lock_timeout') AS v;\n",
      });
      try {
        expect((await migrateDeploy(dir, url, 60_000)).code).toBe(0);
        const db = new SQL(url);
        const rows = await db`SELECT v FROM seen`;
        await db.close();
        expect(rows[0].v).toBe(expected);
      } finally {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }
    },
    90_000,
  );
});
