import { expect, test } from "bun:test";
import { posix } from "node:path";

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

test("the Web integration workflow runs every shard independently with a Bun package cache", async () => {
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
  expect(steps.find(({ name }) => name === "Cache Bun packages")?.with).toMatchObject({
    path: "~/.bun/install/cache",
    key: expect.stringContaining("hashFiles('mise.toml', 'bun.lock')"),
  });
  expect(steps.find(({ name }) => name === "Install dependencies")?.run).toBe(
    "bun install --frozen-lockfile",
  );
  expect(steps.find(({ name }) => name === "Run the integration suites")?.run).toContain("--shard");
  expect(steps.find(({ name }) => name === "Keep the log of a failed run")?.with?.name).toContain(
    "matrix.shard",
  );
});
