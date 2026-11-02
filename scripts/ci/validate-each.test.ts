import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runs validate-each.sh with a `bun` that logs its arguments, and fails when they contain `failing`. */
async function run(kind: string, selected: string[], failing?: string) {
  const dir = await mkdtemp(join(tmpdir(), "coforge-validate-each-"));
  try {
    const log = join(dir, "calls");
    await Bun.write(
      join(dir, "bun"),
      `#!/usr/bin/env bash\necho "$*" >> "${log}"\n${failing ? `[[ "$*" != *${failing}* ]]\n` : ""}`,
    );
    await chmod(join(dir, "bun"), 0o755);
    const child = Bun.spawnSync(
      ["bash", "scripts/ci/validate-each.sh", kind, JSON.stringify(selected)],
      { env: { ...Bun.env, PATH: `${dir}:${Bun.env.PATH}` } },
    );
    const calls = (await Bun.file(log).text()).trim().split("\n");
    return { exitCode: child.exitCode, stdout: child.stdout.toString(), calls };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("every selected script suite is tested and checked, and one failure still runs the rest", async () => {
  const result = await run("scripts", ["ci", "deploy", "release"], "test:deploy");
  expect(result.calls).toEqual([
    "run test:ci",
    "run check:ci",
    "run test:deploy",
    "run test:release",
    "run check:release",
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toContain("::error::Failed: deploy\n");
});

test("each library package is tested, checked, and built when it has a build script", async () => {
  const result = await run("libraries", ["anvil", "coforge-sdk"]);
  expect(result.calls).toEqual([
    "run --cwd packages/anvil test",
    "run --cwd packages/anvil check",
    "run --cwd packages/anvil --if-present build",
    "run --cwd packages/coforge-sdk test",
    "run --cwd packages/coforge-sdk check",
    "run --cwd packages/coforge-sdk --if-present build",
  ]);
  expect(result.exitCode).toBe(0);
});
