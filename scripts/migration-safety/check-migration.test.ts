import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAnnotation, split } from "./annotation";
import { createdBySiblings, main } from "./check-migration";
import type { Snapshot } from "./snapshot";

const now = new Date("2026-10-31T12:00:00.000Z");
const root = mkdtempSync(join(tmpdir(), "check-migration-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function snapshotOf(
  tables: Record<string, number>,
  generatedAt = "2026-10-31T03:00:00.000Z",
): Snapshot {
  return {
    version: 1,
    generatedAt,
    environment: "production",
    tables: Object.entries(tables).map(([name, approxRows]) => ({
      schema: "public",
      name,
      approxRows,
      totalBytes: approxRows * 100,
    })),
  };
}

let dir: string;
let counter = 0;
beforeEach(() => {
  dir = join(root, `case-${counter++}`);
  mkdirSync(dir, { recursive: true });
});

function migration(sql: string, name = "20261101000000_change"): string {
  mkdirSync(join(dir, name), { recursive: true });
  const file = join(dir, name, "migration.sql");
  writeFileSync(file, sql);
  return file;
}
function snapshotFile(snapshot: Snapshot): string {
  const path = join(dir, "snapshot.json");
  writeFileSync(path, JSON.stringify(snapshot));
  return path;
}

/** Runs the CLI, returning its exit code and what it printed to stderr. */
async function run(...args: string[]): Promise<{ code: number; stderr: string }> {
  const errors: string[] = [];
  const err = spyOn(console, "error").mockImplementation(
    (...parts) => void errors.push(parts.join(" ")),
  );
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    return { code: await main(args, now), stderr: errors.join("\n") };
  } finally {
    err.mockRestore();
    log.mockRestore();
  }
}

const RISKY =
  "SET lock_timeout = '5s';\nALTER TABLE tasks ALTER COLUMN title SET NOT NULL;\nRESET lock_timeout;\n";
const small = snapshotOf({ tasks: 1000 });
const large = snapshotOf({ tasks: 5_000_000 });

describe("--write", () => {
  test("writes an annotation that --verify and --ci accept", async () => {
    const file = migration(RISKY);
    const snapshot = snapshotFile(small);
    expect((await run("--write", "--snapshot", snapshot, file)).code).toBe(0);

    const text = readFileSync(file, "utf8");
    expect(text.split("\n").slice(0, 3)).toEqual([
      "-- migration-safety v1",
      "-- checked: 2026-10-31T12:00:00.000Z  pg: 18.0  verdict: ok-with-lock-timeout",
      "-- snapshot: 2026-10-31T03:00:00.000Z production",
    ]);
    expect(text).toContain(
      '-- table: "tasks" rows≈1000 size=100000 lock=access-exclusive rewrite=yes statement=ALTER TABLE SET NOT NULL',
    );
    expect(split(text).body).toBe(RISKY);
    expect((await run("--verify", file)).code).toBe(0);
    expect((await run("--ci", "--snapshot", snapshot, file)).code).toBe(0);
  });

  test("rewriting an annotated file replaces the old annotation", async () => {
    const file = migration(RISKY);
    const snapshot = snapshotFile(small);
    await run("--write", "--snapshot", snapshot, file);
    const once = readFileSync(file, "utf8");
    await run("--write", "--snapshot", snapshot, file);
    expect(readFileSync(file, "utf8")).toBe(once);
  });

  test("refuses a migration that must be rewritten, and writes nothing", async () => {
    const file = migration(RISKY);
    const result = await run("--write", "--snapshot", snapshotFile(large), file);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("must be rewritten");
    expect(readFileSync(file, "utf8")).toBe(RISKY);
  });

  test("refuses a migration with no lock_timeout", async () => {
    const result = await run(
      "--write",
      "--snapshot",
      snapshotFile(small),
      migration("DROP TABLE tasks;\n"),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("lock_timeout");
  });

  test("a migration with nothing high risk gets no annotation", async () => {
    const file = migration(
      "SET lock_timeout = '5s';\nALTER TABLE tasks ADD COLUMN note text;\nRESET lock_timeout;\n",
    );
    expect((await run("--write", "--snapshot", snapshotFile(small), file)).code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(
      "SET lock_timeout = '5s';\nALTER TABLE tasks ADD COLUMN note text;\nRESET lock_timeout;\n",
    );
  });

  test("a table another migration creates counts as empty", async () => {
    migration("CREATE TABLE ghosts (id int);\n", "20261031000000_create");
    const file = migration(
      "SET lock_timeout = '5s';\nALTER TABLE ghosts ALTER COLUMN id SET NOT NULL;\nRESET lock_timeout;\n",
    );
    expect((await run("--write", "--snapshot", snapshotFile(small), file)).code).toBe(0);
  });
});

describe("--verify", () => {
  test("a migration with nothing high risk needs no annotation", async () => {
    expect(
      (
        await run(
          "--verify",
          migration("CREATE TABLE a (id int);\nALTER TABLE a ADD COLUMN b text;\n"),
        )
      ).code,
    ).toBe(0);
  });

  test("a high-risk migration with no annotation says what to do", async () => {
    const file = migration(RISKY);
    const result = await run("--verify", file);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("high-risk statements need a safety annotation");
    expect(result.stderr).toContain("--write --snapshot <latest snapshot>");
    expect(result.stderr).toContain("expand-contract / NOT VALID + VALIDATE / CONCURRENTLY");
  });

  test("an edit after the annotation fails the hash", async () => {
    const file = migration(RISKY);
    await run("--write", "--snapshot", snapshotFile(small), file);
    writeFileSync(file, readFileSync(file, "utf8").replace("title", "name"));
    const result = await run("--verify", file);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("edited after its safety annotation");
  });

  test.each([
    ["wrong first line", (text: string) => text.replace("v1", "v2")],
    [
      "a bad verdict",
      (text: string) => text.replace("verdict: ok-with-lock-timeout", "verdict: fine"),
    ],
    ["a bad hash", (text: string) => text.replace(/body-sha256: [0-9a-f]{4}/, "body-sha256: zzzz")],
    ["a bad table line", (text: string) => text.replace("rows≈", "rows=")],
    ["a missing snapshot line", (text: string) => text.replace(/-- snapshot: .*\n/, "")],
  ])("an annotation with %s is invalid", async (_name, damage) => {
    const file = migration(RISKY);
    await run("--write", "--snapshot", snapshotFile(small), file);
    writeFileSync(file, damage(readFileSync(file, "utf8")));
    expect((await run("--verify", file)).code).toBe(1);
  });

  test("an annotation that does not describe the statements fails", async () => {
    const file = migration(RISKY);
    await run("--write", "--snapshot", snapshotFile(small), file);
    const body = split(readFileSync(file, "utf8")).body.replace(
      "SET NOT NULL",
      "DROP NOT NULL; DROP TABLE tasks",
    );
    const { annotation } = parseAnnotation(readFileSync(file, "utf8"));
    const forged = readFileSync(file, "utf8").replace(
      annotation!.bodySha256,
      (await import("./annotation")).sha256(body),
    );
    writeFileSync(file, forged.replace(split(forged).body, body));
    const result = await run("--verify", file);
    expect(result.stderr).toContain("does not describe the migration's statements");
  });

  test("a rewrite verdict is rejected", async () => {
    const file = migration(RISKY);
    await run("--write", "--snapshot", snapshotFile(small), file);
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("verdict: ok-with-lock-timeout", "verdict: rewrite"),
    );
    expect((await run("--verify", file)).stderr).toContain("verdict is rewrite");
  });

  test("a verdict of ok is rejected when blocking locks are taken", async () => {
    const file = migration(RISKY);
    await run("--write", "--snapshot", snapshotFile(small), file);
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("verdict: ok-with-lock-timeout", "verdict: ok"),
    );
    expect((await run("--verify", file)).stderr).toContain("annotation says ok");
  });

  test("CONCURRENTLY mixed with other statements is rejected", async () => {
    const file = migration("CREATE INDEX CONCURRENTLY i ON tasks (a);\nSELECT 1;\n");
    expect((await run("--verify", file)).stderr).toContain("must be the only statement");
  });
});

describe("--ci", () => {
  async function annotated(snapshot: Snapshot) {
    const file = migration(RISKY);
    await run("--write", "--snapshot", snapshotFile(snapshot), file);
    return file;
  }

  test("row and size drift inside the same tier is fine", async () => {
    const file = await annotated(small);
    expect(
      (await run("--ci", "--snapshot", snapshotFile(snapshotOf({ tasks: 90_000 })), file)).code,
    ).toBe(0);
  });

  test("a table that grew past the threshold fails", async () => {
    const file = await annotated(small);
    const result = await run("--ci", "--snapshot", snapshotFile(large), file);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("must be rewritten");
  });

  test("a snapshot of 15 days fails closed; 13 days passes", async () => {
    const file = await annotated(small);
    const old = await run(
      "--ci",
      "--snapshot",
      snapshotFile(snapshotOf({ tasks: 1000 }, "2026-10-16T00:00:00.000Z")),
      file,
    );
    expect(old.code).toBe(1);
    expect(old.stderr).toContain("days old");
    expect(
      (
        await run(
          "--ci",
          "--snapshot",
          snapshotFile(snapshotOf({ tasks: 1000 }, "2026-10-18T12:00:00.000Z")),
          file,
        )
      ).code,
    ).toBe(0);
  });

  test("a missing or unreadable snapshot fails closed for a high-risk migration only", async () => {
    const file = await annotated(small);
    const missing = await run("--ci", "--snapshot", join(dir, "absent.json"), file);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("fails closed");
    writeFileSync(join(dir, "broken.json"), "{");
    expect((await run("--ci", "--snapshot", join(dir, "broken.json"), file)).code).toBe(1);
    const plain = migration(
      "SET lock_timeout = '5s';\nALTER TABLE tasks ADD COLUMN note text;\nRESET lock_timeout;\n",
      "20261102000000_plain",
    );
    expect((await run("--ci", "--snapshot", join(dir, "absent.json"), plain)).code).toBe(0);
  });

  test("a verdict that changed with the tables fails", async () => {
    const file = migration("UPDATE tasks SET a = 1;\n");
    await run("--write", "--snapshot", snapshotFile(small), file);
    expect(readFileSync(file, "utf8")).toContain("verdict: ok");
    expect((await run("--ci", "--snapshot", snapshotFile(large), file)).stderr).toContain(
      "must be rewritten",
    );
  });
});

test("usage errors exit 2", async () => {
  expect((await run()).code).toBe(2);
  expect((await run("--ci", migration("SELECT 1;"))).code).toBe(2);
  expect((await run("--verify", join(dir, "nope.sql"))).code).toBe(2);
});

test("a migration is not its own sibling, however its path is spelled", () => {
  migration("CREATE TABLE other (id int);\n", "20261031000000_other");
  const file = migration("CREATE TABLE mine (id int);\n", "20261101000000_mine");
  const spelled = `${dir}/./20261101000000_mine/../20261101000000_mine/migration.sql`;
  expect([...createdBySiblings(spelled)]).toEqual(["other"]);
  expect([...createdBySiblings(file)]).toEqual(["other"]);
});
