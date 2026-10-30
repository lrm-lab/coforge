import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatAnnotation, PG_VERSION } from "./annotation";
import type { CatalogSource } from "./catalog-query";
import { deployGate } from "./deploy-gate";
import { LAST_GRANDFATHERED_MIGRATION } from "./grandfather";
import { analyze, judge } from "./rules";
import { catalogOf, type TableStat } from "./snapshot";

const now = new Date("2026-10-31T12:00:00.000Z");
const root = mkdtempSync(join(tmpdir(), "deploy-gate-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const stat = (name: string, approxRows: number): TableStat => ({
  schema: "public",
  name,
  approxRows,
  totalBytes: approxRows * 100,
});
const RISKY =
  "SET lock_timeout = '5s';\nALTER TABLE tasks ALTER COLUMN title SET NOT NULL;\nRESET lock_timeout;\n";

/** A fake database: the migrations it has applied and the table sizes pg_class reports. */
function fakeSource(
  applied: string[] | Error,
  tables: TableStat[],
): CatalogSource & { closed: boolean } {
  return {
    closed: false,
    async applied() {
      if (applied instanceof Error) throw applied;
      return applied;
    },
    async tables() {
      return tables;
    },
    async close() {
      this.closed = true;
    },
  };
}

/** The migration with the annotation `check-migration --write` would give it against `tables`. */
function annotate(sql: string, tables: TableStat[], created: string[] = []): string {
  const judgement = judge(analyze(sql), catalogOf({ tables }), new Set(created));
  return formatAnnotation(
    {
      checked: now.toISOString(),
      pg: PG_VERSION,
      verdict: judgement.verdict,
      snapshotAt: now.toISOString(),
      snapshotEnvironment: "production",
      tables: judgement.lines,
    },
    sql,
  );
}

let counter = 0;
function migrations(files: Record<string, string>): string {
  const dir = join(root, `m${counter++}`);
  for (const [name, sql] of Object.entries(files)) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "migration.sql"), sql);
  }
  writeFileSync(join(dir, "migration_lock.toml"), 'provider = "postgresql"\n');
  return dir;
}

async function gate(source: CatalogSource, dir: string) {
  const errors: string[] = [];
  const spy = spyOn(console, "error").mockImplementation(
    (...parts) => void errors.push(parts.join(" ")),
  );
  try {
    return { code: await deployGate(source, dir, now), stderr: errors.join("\n") };
  } finally {
    spy.mockRestore();
  }
}

describe("deploy gate", () => {
  test("passes when every pending migration is safe against the live catalog", async () => {
    const tables = [stat("tasks", 1000)];
    const dir = migrations({
      "20261001000000_old": "DROP TABLE legacy;\n",
      "20261101000000_new": annotate(RISKY, tables),
      "20261102000000_plain":
        "SET lock_timeout = '5s';\nALTER TABLE tasks ADD COLUMN note text;\nRESET lock_timeout;\n",
    });
    const source = fakeSource(["20261001000000_old"], tables);
    expect(await gate(source, dir)).toMatchObject({ code: 0 });
    expect(source.closed).toBe(true);
  });

  test("an applied migration is never judged, annotated or not", async () => {
    const dir = migrations({ "20261001000000_old": "DROP TABLE legacy;\n" });
    expect((await gate(fakeSource(["20261001000000_old"], []), dir)).code).toBe(0);
  });

  test("a pending high-risk migration without an annotation stops the deploy with the fix", async () => {
    const dir = migrations({ "20261101000000_new": RISKY });
    const result = await gate(fakeSource([], [stat("tasks", 1000)]), dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("before any migration runs");
    expect(result.stderr).toContain("20261101000000_new/migration.sql");
    expect(result.stderr).toContain(
      "re-run `bun scripts/migration-safety/check-migration.ts --write --snapshot <latest snapshot>`",
    );
    expect(result.stderr).toContain("download the latest catalog-snapshot artifact");
    expect(result.stderr).toContain(
      "rewrite the migration in steps (expand-contract / NOT VALID + VALIDATE / CONCURRENTLY)",
    );
  });

  test("a table that has outgrown its annotation stops the deploy", async () => {
    const dir = migrations({ "20261101000000_new": annotate(RISKY, [stat("tasks", 1000)]) });
    const result = await gate(fakeSource([], [stat("tasks", 2_000_000)]), dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("must be rewritten");
  });

  test("an unknown row count is judged by the table's size", async () => {
    const dir = migrations({ "20261101000000_new": annotate(RISKY, [stat("tasks", 1000)]) });
    const unanalyzed = (totalBytes: number) => [{ ...stat("tasks", -1), totalBytes }];
    expect((await gate(fakeSource([], unanalyzed(8192)), dir)).code).toBe(0);
    expect((await gate(fakeSource([], unanalyzed(900 * 1024 * 1024)), dir)).code).toBe(1);
  });

  test("migrations up to the grandfather cutoff are never judged, the next one is", async () => {
    const bad = "DROP TABLE tasks;\n";
    const dir = migrations({
      [LAST_GRANDFATHERED_MIGRATION]: bad,
      "20261030170000_machine_status0": bad,
      "20261030165959_before": bad,
    });
    const tables = [stat("tasks", 1000)];
    // 20261030170000_machine_status0 sorts after the cutoff name, so only it is judged.
    const result = await gate(fakeSource([], tables), dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("20261030170000_machine_status0");
    expect(result.stderr).not.toContain("20261030165959_before");
    expect(result.stderr).not.toContain(`${LAST_GRANDFATHERED_MIGRATION}/migration.sql`);
    const onlyOld = migrations({
      [LAST_GRANDFATHERED_MIGRATION]: bad,
      "20261030165959_before": bad,
    });
    expect((await gate(fakeSource([], tables), onlyOld)).code).toBe(0);
  });

  test("an annotation edited after it was written stops the deploy", async () => {
    const tables = [stat("tasks", 1000)];
    const dir = migrations({
      "20261101000000_new": annotate(RISKY, tables).replace("title", "name"),
    });
    expect((await gate(fakeSource([], tables), dir)).stderr).toContain(
      "edited after its safety annotation",
    );
  });

  test("a table an earlier pending migration creates is not in the live catalog yet", async () => {
    const sql =
      "SET lock_timeout = '5s';\nALTER TABLE ghosts ALTER COLUMN id SET NOT NULL;\nRESET lock_timeout;\n";
    const dir = migrations({
      "20261101000000_create": "CREATE TABLE ghosts (id int);\n",
      "20261102000000_alter": annotate(sql, [], ["ghosts"]),
    });
    expect((await gate(fakeSource([], []), dir)).code).toBe(0);
  });

  test("a failure to read the catalog stops the deploy", async () => {
    const dir = migrations({ "20261101000000_plain": "SELECT 1;\n" });
    const result = await gate(fakeSource(new Error("connection refused"), []), dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("connection refused");
  });

  test("a missing migrations directory stops the deploy", async () => {
    expect((await gate(fakeSource([], []), join(root, "absent"))).code).toBe(2);
  });
});
