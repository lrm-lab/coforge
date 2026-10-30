import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const deployScript = join(__dirname, "blue-green-deploy.sh");
const rollbackScript = join(__dirname, "rollback.sh");
const digest = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

async function runScript(
  script: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([script, ...args], {
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

describe("blue-green-deploy CLI validation", () => {
  test("fails when required arguments are missing", async () => {
    const result = await runScript(deployScript, []);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("usage:");
  });

  test("rejects mutable image tags", async () => {
    const result = await runScript(deployScript, [
      "--image",
      "ghcr.io/lrm-lab/coforge/coforge-web:latest",
      "--compose-file",
      "/tmp/fake-compose.yml",
      "--secrets-dir",
      "/tmp/fake-secrets",
      "--state-file",
      "/tmp/fake-state.env",
      "--public-health-url",
      "https://example.com/health",
    ]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("outcome=failed");
    expect(result.stdout).toContain("mutable image reference rejected");
  });
});

describe("rollback script", () => {
  let tempDir: string;
  let stateFile: string;
  let composeFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "coforge-rollback-test-"));
    stateFile = join(tempDir, "state.env");
    composeFile = join(tempDir, "docker-compose.yml");
    await mkdir(join(tempDir, "caddy"), { recursive: true });
    await writeFile(join(tempDir, "caddy/upstream.caddy"), "reverse_proxy web_green:3000\n");
    await writeFile(composeFile, "services: {}\n");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("fails when state file does not exist", async () => {
    const result = await runScript(rollbackScript, [
      "--compose-file",
      composeFile,
      "--state-file",
      join(tempDir, "nonexistent.env"),
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("does not exist");
  });

  test("identifies target slot and fails gracefully when container does not exist on test machine", async () => {
    await writeFile(
      stateFile,
      `ACTIVE_SLOT=green\nPREVIOUS_SLOT=blue\nCURRENT_WEB_IMAGE=ghcr.io/lrm-lab/coforge/coforge-web@${digest}\nPREVIOUS_WEB_IMAGE=ghcr.io/lrm-lab/coforge/coforge-web@${digest}\n`,
    );

    const result = await runScript(rollbackScript, [
      "--compose-file",
      composeFile,
      "--state-file",
      stateFile,
      "--project",
      "test-project",
      "--timeout",
      "5",
    ]);

    // Container does not exist in local unit test environment
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("initiating rollback from slot green to previous slot blue");
    expect(result.stderr).toContain("target container for slot blue not found");
  });
});
