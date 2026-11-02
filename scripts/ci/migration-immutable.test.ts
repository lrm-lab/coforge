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

test("a migration not yet pushed may be edited; one on the upstream may not", () => {
  const existing = "apps/web/prisma/migrations/20260101000000_a/migration.sql";
  const added = "apps/web/prisma/migrations/20260202000000_b/migration.sql";
  repo.seed({ "README.md": "# Repo\n", [existing]: "CREATE TABLE a ();\n" });
  const remote = `${repo.dir}.git`;
  Bun.spawnSync(["git", "init", "--bare", "-q", remote]);
  repo.ok("remote", "add", "origin", remote);
  repo.ok("push", "-q", "-u", "origin", "HEAD:refs/heads/main");

  repo.write({ [added]: "CREATE TABLE b ();\n" });
  repo.ok("add", "-A");
  repo.ok("commit", "-q", "-m", "add b");
  repo.write({ [added]: "CREATE TABLE b (id int);\n" });
  expect(repo.commitAll().exitCode).toBe(0);

  repo.write({ [existing]: "CREATE TABLE a (id int);\n" });
  const published = repo.commitAll();
  expect(published.exitCode).not.toBe(0);
  expect(published.stderr).toContain("migration-immutable");
});
