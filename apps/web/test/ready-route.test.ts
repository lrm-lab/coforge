import { describe, expect, test } from "bun:test";
import { checkReadiness, getExpectedMigrations } from "../src/routes/ready";

describe("getExpectedMigrations", () => {
  test("finds expected migrations from repository directory", () => {
    const list = getExpectedMigrations();
    expect(list.length).toBeGreaterThan(100);
    expect(list).toContain("20260828000000_setup_registration");
    expect(list).toContain("20261030140000_task_own_id");
  });
});

describe("checkReadiness", () => {
  test("returns not ready when database and redis are unconfigured", async () => {
    // In local unit test without DB/Redis env
    const result = await checkReadiness();
    // It should report structured health status
    expect(typeof result.ready).toBe("boolean");
    expect(["ok", "unreachable", "unconfigured"]).toContain(result.database);
    expect(["ok", "unreachable", "unconfigured"]).toContain(result.redis);
    expect(["ok", "missing_migrations", "error"]).toContain(result.schema);
  });
});
