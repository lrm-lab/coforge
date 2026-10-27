import { expect, test } from "bun:test";

const migration = await Bun.file(
  new URL(
    "../prisma/migrations/20261027160000_host_job_runtime_operation/migration.sql",
    import.meta.url,
  ),
).text();

test("host jobs may record a cloud runtime upgrade", () => {
  expect(migration).toContain('DROP CONSTRAINT "host_jobs_operation_check"');
  expect(migration).toContain("IN ('create', 'delete', 'attach', 'update', 'runtime')");
});
