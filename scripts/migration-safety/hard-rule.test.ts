import { describe, expect, test } from "bun:test";
import { delimiter, dirname, join } from "node:path";
import { useTestRepo } from "../git-hooks/test-repo";
import { LAST_GRANDFATHERED_MIGRATION } from "./grandfather";

// The migration-safety hard rule on real commits and ranges, through the real checker.
const repo = useTestRepo();
const cli = join(import.meta.dir, "check-migration.ts");
const OFFLINE = { GITHUB_ACTIONS: "", CI: "", MIGRATION_SAFETY_SNAPSHOT: "" };
const migration = (name: string) => `apps/web/prisma/migrations/${name}/migration.sql`;
const RISKY =
  "SET lock_timeout = '5s';\nALTER TABLE tasks ALTER COLUMN title SET NOT NULL;\nRESET lock_timeout;\n";
const snapshot = (rows: number) =>
  JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    environment: "production",
    tables: [{ schema: "public", name: "tasks", approxRows: rows, totalBytes: rows * 100 }],
  });

/** Writes the annotation `check-migration --write` gives `path` (in the work tree), against a snapshot. */
function annotate(path: string, rows = 1000) {
  repo.write({ "snapshot.json": snapshot(rows) });
  const result = repo.run(
    [process.execPath, cli, "--write", "--snapshot", "snapshot.json", path],
    OFFLINE,
  );
  expect(result.exitCode).toBe(0);
}

describe("pre-commit (offline)", () => {
  test("an unannotated high-risk migration is blocked with the rule and the fix", () => {
    repo.seed({ "README.md": "# r\n" });
    repo.write({ [migration("20261101000000_a")]: RISKY });
    const result = repo.commitAll(OFFLINE);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Blocked by hard rule migration-safety");
    expect(result.stderr).toContain(migration("20261101000000_a"));
    expect(result.stderr).toContain("catalog-snapshot");
    expect(result.stderr).toContain("check-migration.ts --write --snapshot");
  });

  test("an annotated one passes, and an edit after the annotation is blocked", () => {
    repo.seed({ "README.md": "# r\n" });
    const path = migration("20261101000000_a");
    repo.write({ [path]: RISKY });
    annotate(path);
    expect(repo.commitAll(OFFLINE).exitCode).toBe(0);

    const edited = migration("20261102000000_b");
    repo.write({ [edited]: RISKY });
    annotate(edited);
    repo.write({ [edited]: repo.run(["cat", edited]).stdout.replace("title", "name") });
    const result = repo.commitAll(OFFLINE);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("edited after its safety annotation");
  });

  test("a migration that must be rewritten has no valid annotation to commit", () => {
    repo.seed({ "README.md": "# r\n" });
    const path = migration("20261101000000_a");
    repo.write({ [path]: RISKY, "snapshot.json": snapshot(5_000_000) });
    const written = repo.run(
      [process.execPath, cli, "--write", "--snapshot", "snapshot.json", path],
      OFFLINE,
    );
    expect(written.exitCode).toBe(1);
    expect(repo.commitAll(OFFLINE).exitCode).not.toBe(0);
  });

  test("a migration with nothing high risk passes without an annotation", () => {
    repo.seed({ "README.md": "# r\n" });
    repo.write({
      [migration("20261101000000_a")]:
        'CREATE TABLE "x" (id int);\nCREATE INDEX "x_i" ON "x" (id);\n',
    });
    expect(repo.commitAll(OFFLINE).exitCode).toBe(0);
  });

  test("migrations already in the base are never judged, edited or not", () => {
    const old = migration("20260101000000_old");
    repo.seed({ [old]: "DROP TABLE legacy;\n" });
    repo.write({ [old]: "DROP TABLE legacy;\n-- touched\n" });
    expect(repo.commitAll(OFFLINE).exitCode).toBe(0);
  });

  test("a new migration may use a table another new migration creates", () => {
    repo.seed({ "README.md": "# r\n" });
    repo.write({
      [migration("20261101000000_a")]: "CREATE TABLE ghosts (id int);\n",
      [migration("20261102000000_b")]:
        "SET lock_timeout = '5s';\nALTER TABLE ghosts ALTER COLUMN id SET NOT NULL;\nRESET lock_timeout;\n",
    });
    annotate(migration("20261102000000_b"));
    expect(repo.commitAll(OFFLINE).exitCode).toBe(0);
  });
});

describe("the grandfather cutoff", () => {
  test("a migration named at or before it is exempt, the next name is judged", () => {
    repo.seed({ "README.md": "# r\n" });
    repo.write({
      [migration(LAST_GRANDFATHERED_MIGRATION)]: "DROP TABLE legacy;\n",
      [migration("20260101000000_older")]: "DROP TABLE legacy;\n",
    });
    expect(repo.commitAll(OFFLINE).exitCode).toBe(0);
    repo.write({ [migration(`${LAST_GRANDFATHERED_MIGRATION}0`)]: "DROP TABLE legacy;\n" });
    const result = repo.commitAll(OFFLINE);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(`${LAST_GRANDFATHERED_MIGRATION}0`);
  });
});

describe("CI (a range)", () => {
  function pushed(rows?: number) {
    const base = repo.seed({ "README.md": "# r\n" });
    const path = migration("20261101000000_a");
    repo.write({ [path]: RISKY });
    annotate(path, rows);
    repo.seed({ [path]: repo.run(["cat", path]).stdout }, { message: "add" });
    return base;
  }

  test("with the production snapshot the annotation is recomputed and accepted", () => {
    const base = pushed();
    repo.write({ "snapshot.json": snapshot(1000) });
    const result = repo.check(["--range", base, "HEAD"], {
      GITHUB_ACTIONS: "true",
      MIGRATION_SAFETY_SNAPSHOT: join(repo.dir, "snapshot.json"),
    });
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("a table that has grown past the threshold since the annotation fails", () => {
    const base = pushed();
    repo.write({ "snapshot.json": snapshot(5_000_000) });
    const result = repo.check(["--range", base, "HEAD"], {
      GITHUB_ACTIONS: "true",
      MIGRATION_SAFETY_SNAPSHOT: join(repo.dir, "snapshot.json"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("must be rewritten");
  });

  test("without a snapshot it fails closed for a high-risk migration", () => {
    const base = pushed();
    const result = repo.check(["--range", base, "HEAD"], {
      GITHUB_ACTIONS: "true",
      MIGRATION_SAFETY_SNAPSHOT: "",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("fails closed");
  });

  test("without a snapshot a migration with nothing high risk still passes", () => {
    const base = repo.seed({ "README.md": "# r\n" });
    repo.seed(
      { [migration("20261101000000_a")]: 'CREATE TABLE "x" (id int);\n' },
      { message: "add" },
    );
    expect(
      repo.check(["--range", base, "HEAD"], {
        GITHUB_ACTIONS: "true",
        MIGRATION_SAFETY_SNAPSHOT: "",
      }).exitCode,
    ).toBe(0);
  });

  test("in CI the latest production snapshot is found by artifact name and downloaded with gh", () => {
    const base = pushed();
    repo.write({
      "bin/gh": `#!/bin/sh
case "$1 $2" in
  "api repos/owner/repo/actions/artifacts?name=catalog-snapshot-production&per_page=100") echo 100 ;;
  "run download")
    [ "$3" = 100 ] || exit 1
    while [ "$1" != --dir ]; do shift; done
    cp "${join(repo.dir, "snapshot.json")}" "$2/catalog-snapshot.json" ;;
  *) exit 1 ;;
esac
`,
      "snapshot.json": snapshot(5_000_000),
    });
    Bun.spawnSync(["chmod", "+x", join(repo.dir, "bin/gh")]);
    const env = {
      GITHUB_ACTIONS: "true",
      GH_TOKEN: "token",
      GITHUB_REPOSITORY: "owner/repo",
      PATH: [join(repo.dir, "bin"), dirname(process.execPath), process.env.PATH ?? ""].join(
        delimiter,
      ),
    };
    const result = repo.check(["--range", base, "HEAD"], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("must be rewritten");
  });
});
