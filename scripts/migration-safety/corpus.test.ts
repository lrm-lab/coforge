import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { analyze } from "./rules";

// The repository's own migrations, as written before the check existed: the classifier must read
// all of them. A statement it does not recognise is high risk, so a number above the known one
// means a Prisma idiom was missed (or a new hand-written migration needs a look).
const migrations = join(import.meta.dir, "../../apps/web/prisma/migrations");
const analyses = readdirSync(migrations)
  .map((name) => join(migrations, name, "migration.sql"))
  .filter(existsSync)
  .map((file) => ({ file, analysis: analyze(readFileSync(file, "utf8")) }));

test("every existing migration can be read", () => {
  expect(analyses.length).toBeGreaterThan(100);
  const unreadable = analyses.filter(({ analysis }) =>
    analysis.problems.some((problem) => problem.includes("cannot be read")),
  );
  expect(unreadable.map(({ file }) => file)).toEqual([]);
});

test("the unrecognised statements are the hand-written ones", () => {
  const unknown = analyses.flatMap(({ analysis }) => analysis.risky.filter((risk) => risk.unknown));
  // DO blocks, WITH ... UPDATE, and CREATE TRIGGER: nothing Prisma generates.
  expect(unknown.length).toBe(10);
});
