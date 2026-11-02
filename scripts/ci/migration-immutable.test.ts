import { expect, test } from "bun:test";
import { useTestRepo } from "../git-hooks/test-repo";

const repo = useTestRepo();

test("a migration already on the base is immutable; a new migration is allowed", () => {
  const existing = "apps/web/prisma/migrations/20260101000000_a/migration.sql";
  const added = "apps/web/prisma/migrations/20260202000000_b/migration.sql";
  repo.seed({ "README.md": "# Repo\n", [existing]: "CREATE TABLE a ();\n" });
  repo.write({ [existing]: "CREATE TABLE a (id int);\n", [added]: "CREATE TABLE b ();\n" });

  const result = repo.commitAll();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(existing);
  expect(result.stderr).toContain("migration-immutable");
  expect(result.stderr).not.toContain(added);
});

test("deleting a migration already on the base is blocked", () => {
  const existing = "apps/web/prisma/migrations/20260101000000_a/migration.sql";
  repo.seed({ "README.md": "# Repo\n", [existing]: "CREATE TABLE a ();\n" });
  repo.ok("rm", existing);

  const result = repo.commitAll();

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(existing);
  expect(result.stderr).toContain("migration-immutable");
});
