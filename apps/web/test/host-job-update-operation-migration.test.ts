import { expect, test } from "bun:test";

const migration = await Bun.file(
  new URL(
    "../prisma/migrations/20261023120000_host_job_update_operation/migration.sql",
    import.meta.url,
  ),
).text();

test("host jobs may record a cloud image replace", () => {
  expect(migration).toContain('DROP CONSTRAINT "host_jobs_operation_check"');
  expect(migration).toContain("IN ('create', 'delete', 'attach', 'update')");
});
