import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

import { type Step, parse } from "./workflow-helpers";

const runner = "scripts/test/run-web-integration.sh";
const shardNumbers = [1, 2, 3, 4];

function listShard(shard: number): string[] {
  const result = Bun.spawnSync(["bash", runner, "--shard", String(shard), "--list"]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim().split("\n");
}

test("the Web integration shards cover the discovery set and keep imported suites together", async () => {
  const expected = [
    ...new Bun.Glob("apps/web/test/*.integration*.ts").scanSync({ onlyFiles: true }),
    ...new Bun.Glob("scripts/migration-safety/*.integration.ts").scanSync({ onlyFiles: true }),
  ];
  const shards = shardNumbers.map(listShard);
  expect(shards.flat().sort()).toEqual(expected.sort());
  for (const [index, files] of shards.entries()) {
    expect(files.length).toBeGreaterThan(0);
    expect(files).toEqual([...files].sort());
    expect(listShard(index + 1)).toEqual(files);
  }

  const shardByFile = new Map(
    shards.flatMap((files, shard) => files.map((file) => [file, shard] as const)),
  );
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  for (const [file, shard] of shardByFile) {
    const { imports } = transpiler.scan(await Bun.file(file).text());
    for (const { path } of imports) {
      if (!path.startsWith(".")) continue;
      const target = posix.join(posix.dirname(file), path.endsWith(".ts") ? path : `${path}.ts`);
      if (shardByFile.has(target)) {
        expect(shardByFile.get(target), `${file} imports ${target}`).toBe(shard);
      }
    }
  }
});

test("invalid Web integration shard arguments fail without starting a test", () => {
  for (const args of [
    ["0", "--list"],
    ["5", "--list"],
    ["1", "unexpected"],
  ]) {
    const result = Bun.spawnSync(["bash", runner, "--shard", ...args]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("Usage:");
  }
});

test("the Web integration workflow runs every shard independently with a frozen Bun install", async () => {
  const workflow = Bun.YAML.parse(
    await Bun.file(".github/workflows/web-integration.yml").text(),
  ) as {
    on: Record<string, unknown>;
    jobs: {
      integration: {
        strategy: { "fail-fast": boolean; matrix: { shard: number[] } };
        steps: Array<{ name: string; run?: string; with?: Record<string, string> }>;
      };
    };
  };
  expect(Object.keys(workflow.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
  const { strategy, steps } = workflow.jobs.integration;
  expect(strategy.matrix.shard).toEqual(shardNumbers);
  expect(strategy["fail-fast"]).toBe(false);
  expect(steps.some(({ with: options }) => options?.path === "~/.bun/install/cache")).toBe(false);
  expect(steps.find(({ name }) => name === "Install dependencies")?.run).toBe(
    "bun install --frozen-lockfile",
  );
  expect(steps.find(({ name }) => name === "Run the integration suites")?.run).toContain("--shard");
  expect(steps.find(({ name }) => name === "Keep the log of a failed run")?.with?.name).toContain(
    "matrix.shard",
  );
});

test("only the shard that runs the external display suite installs host Redis", async () => {
  const workflow = await parse("web-integration.yml");
  const steps = workflow.jobs.integration.steps as Step[];
  const plan = steps.find((step) => step.id === "host-redis");
  const install = steps.find((step) => step.name === "Install redis-server");
  expect(plan?.env?.WEB_INTEGRATION_SHARD).toBe("${{ matrix.shard }}");
  expect(install?.if).toBe("steps.host-redis.outputs.required == 'true'");
  expect(install?.run).toBe("scripts/ci/install-redis.sh");
  const consumer = "apps/web/test/agent-display-external.integration.ts";
  const directory = await mkdtemp(join(tmpdir(), "coforge-web-integration-redis-"));
  try {
    let requiringRedis = 0;
    for (const shard of shardNumbers) {
      const required = listShard(shard).includes(consumer);
      const output = join(directory, String(shard));
      const result = Bun.spawnSync(["bash", "-e", "-o", "pipefail", "-c", plan!.run!], {
        env: { ...Bun.env, GITHUB_OUTPUT: output, WEB_INTEGRATION_SHARD: String(shard) },
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(await Bun.file(output).text()).toBe(`required=${required}\n`);
      if (required) requiringRedis++;
    }
    expect(requiringRedis).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
