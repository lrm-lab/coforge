import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const prepareScript = join(repoRoot, "scripts/e2e/prepare-e2e-web.sh");

const nonCommentLines = (source: string) =>
  source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .join("\n");

async function runPrepareWithStubBun(args: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "coforge-e2e-prepare-"));
  const logPath = join(dir, "bun.log");
  const stubBun = join(dir, "bun");
  await writeFile(
    stubBun,
    [
      "#!/usr/bin/env sh",
      'printf "%s\\t%s\\t%s\\n" "$PWD" "${NODE_ENV:-}" "$*" >> "$STUB_BUN_LOG"',
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(stubBun, 0o755);

  try {
    const child = Bun.spawn(["bash", prepareScript, ...args], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        NODE_ENV: "development",
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        STUB_BUN_LOG: logPath,
      },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const log = (await Bun.file(logPath).exists())
      ? (await readFile(logPath, "utf8"))
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [cwd, nodeEnv, command] = line.split("\t");
            return { cwd, nodeEnv, command };
          })
      : [];
    return { exitCode, stdout, stderr, log };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("prepare-e2e-web.sh generates physical Paraglide modules after Vite build and before seeding", async () => {
  const webDir = join(repoRoot, "apps/web");
  const sdkDir = join(repoRoot, "packages/coforge-sdk");

  const base = await runPrepareWithStubBun([]);
  expect(base.exitCode, base.stderr).toBe(0);
  expect(base.log).toEqual([
    { cwd: repoRoot, nodeEnv: "development", command: `run --cwd ${sdkDir} generate` },
    { cwd: webDir, nodeEnv: "development", command: "run db:migrate:deploy" },
    { cwd: webDir, nodeEnv: "production", command: "run build" },
    { cwd: webDir, nodeEnv: "development", command: "run generate-i18n" },
    { cwd: webDir, nodeEnv: "development", command: "run ./scripts/seed-dev-data.ts" },
  ]);

  const withDevSeed = await runPrepareWithStubBun(["--with-dev-seed"]);
  expect(withDevSeed.exitCode, withDevSeed.stderr).toBe(0);
  expect(withDevSeed.log).toEqual([
    ...base.log,
    { cwd: webDir, nodeEnv: "development", command: "run ./scripts/seed-dev.ts" },
  ]);

  const invalid = await runPrepareWithStubBun(["--unknown"]);
  expect(invalid.exitCode).not.toBe(0);
  expect(invalid.log).toEqual([]);
});

test("all Web E2E runners share prepare-e2e-web.sh without duplicating build/seed steps", async () => {
  const runners = [
    { path: "scripts/e2e/run-web-e2e-ci.sh", expectedCall: 'prepare-e2e-web.sh" --with-dev-seed' },
    { path: "scripts/e2e/verify-web.sh", expectedCall: 'prepare-e2e-web.sh"' },
    { path: "scripts/e2e/start-e2e-web.sh", expectedCall: 'prepare-e2e-web.sh"' },
  ];

  for (const runner of runners) {
    const code = nonCommentLines(await readFile(join(repoRoot, runner.path), "utf8"));
    expect(code, runner.path).toContain(runner.expectedCall);
    for (const forbidden of [
      "db:migrate:deploy",
      "bun run build",
      "generate-i18n",
      "seed-dev-data.ts",
      "seed-dev.ts",
    ]) {
      expect(
        code,
        `${runner.path} should delegate ${forbidden} to prepare-e2e-web.sh`,
      ).not.toContain(forbidden);
    }
  }
});
