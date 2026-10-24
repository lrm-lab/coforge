import { expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * The Web integration suites only run when someone points a scratch database at them, and each one
 * checks its own per-area database or Redis test URL - a set whose
 * only teacher is a failure at run time, and whose size is not worth restating here because it grows. `scripts/test/run-web-integration.sh` sets them all from a
 * single variable, and this checks its list still covers every name the suites actually read, so a
 * new suite area fails here, at review, instead of in a run that nobody performs (CI has no
 * PostgreSQL, so these suites never run there).
 */
const NAME = /\b[A-Z][A-Z0-9_]*(?:_TEST_DATABASE_URL|_TEST_REDIS_URL)\b/g;

const root = (path: string) => join(import.meta.dir, "../..", path);

test("the integration runner sets every test URL the suites read", async () => {
  const directory = root("apps/web/test");
  const files = (await readdir(directory)).filter((name) => name.includes(".integration"));
  const runner = await readFile(root("scripts/test/run-web-integration.sh"), "utf8");

  const names = new Set<string>();
  for (const file of files) {
    const source = await readFile(join(directory, file), "utf8");
    for (const match of source.matchAll(NAME)) names.add(match[0]);
  }

  // Non-vacuity: if the filter or the pattern stops matching, this test must not pass by finding
  // nothing to check.
  expect(files.length).toBeGreaterThan(50);
  expect(names.size).toBeGreaterThan(10);

  const missing = [...names].filter((name) => !runner.includes(name)).sort();
  expect(missing).toEqual([]);
});

async function runSchemaFixture(ddl: string) {
  const temporary = await mkdtemp(join(tmpdir(), "integration-schema-"));
  try {
    await Bun.write(join(temporary, "source.sql"), ddl);
    await Bun.write(
      join(temporary, "node"),
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n case "$1" in\n --to-schema) [ "$2" = "prisma" ] || exit 7; shift ;;\n --output) cp "$SCHEMA_FIXTURE_SOURCE" "$2"; exit 0 ;;\n esac\n shift\ndone\nexit 2\n',
    );
    await Bun.write(
      join(temporary, "bun"),
      '#!/bin/sh\n[ -n "${MEMORY_THREAD_TEST_SCHEMA_SQL:-}" ] || exit 9\n[ -s "$MEMORY_THREAD_TEST_SCHEMA_SQL" ] || exit 8\nprintf "%s\\n" "$MEMORY_THREAD_TEST_SCHEMA_SQL"\n',
    );
    await chmod(join(temporary, "node"), 0o700);
    await chmod(join(temporary, "bun"), 0o700);
    const child = Bun.spawn(["bash", root("scripts/test/run-web-integration.sh")], {
      env: {
        ...Bun.env,
        PATH: `${temporary}:${Bun.env.PATH}`,
        TMPDIR: temporary,
        MEMORY_THREAD_TEST_SCHEMA_SQL: undefined,
        SCHEMA_FIXTURE_SOURCE: join(temporary, "source.sql"),
        INTEGRATION_DATABASE_URL: "postgresql://unused/unused",
        INTEGRATION_REDIS_URL: "redis://unused",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exit, output, errors, temporary };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test("the canonical integration runner supplies and cleans its complete branch schema fixture", async () => {
  const { exit, output, temporary } = await runSchemaFixture(
    `CREATE TABLE "users" ();\n${"-- schema\n".repeat(200)}`,
  );
  expect(exit).toBe(0);
  const fixture = output.trim();
  expect(fixture.startsWith(temporary)).toBe(true);
  expect(await Bun.file(fixture).exists()).toBe(false);
});

test("the integration runner refuses empty or truncated schema DDL before running tests", async () => {
  for (const ddl of ["", "-- This is an empty migration.\n"]) {
    const { exit, output, errors } = await runSchemaFixture(ddl);
    expect(exit).toBe(1);
    expect(output).toBe("");
    expect(errors).toContain("Incomplete integration schema fixture");
  }
});
