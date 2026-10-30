import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const scriptPath = join(__dirname, "check-migration-safety.sh");
const migrationsDir = join(__dirname, "../../apps/web/prisma/migrations");

async function runSafetyCheck(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([scriptPath, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("check-migration-safety", () => {
  test("flags task #343 (20261030140000_task_own_id) as destructive and exits 1", async () => {
    const target = join(migrationsDir, "20261030140000_task_own_id/migration.sql");
    const result = await runSafetyCheck([target]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("[DESTRUCTIVE]");
    expect(result.stderr).toContain("Rename detected");
    expect(result.stderr).toContain("Primary key / constraint destruction detected");
    expect(result.stderr).toContain("FAILED with 5 destructive migration violation(s)");
  });

  test("allows task #343 when ALLOW_BREAKING_MIGRATION=true", async () => {
    const target = join(migrationsDir, "20261030140000_task_own_id/migration.sql");
    const result = await runSafetyCheck([target], { ALLOW_BREAKING_MIGRATION: "true" });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("bypassed via ALLOW_BREAKING_MIGRATION=true");
  });

  test("allows task #343 when --allow-breaking flag is passed", async () => {
    const target = join(migrationsDir, "20261030140000_task_own_id/migration.sql");
    const result = await runSafetyCheck(["--allow-breaking", target]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("bypassed via ALLOW_BREAKING_MIGRATION=true");
  });

  test("passes safe migration 20261030130000_user_experiments", async () => {
    const target = join(migrationsDir, "20261030130000_user_experiments/migration.sql");
    const result = await runSafetyCheck([target]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("PASSED (checked 1 files)");
  });
});
