import { expect, test } from "bun:test";

/**
 * scripts/e2e/web-e2e-ci.txt is the list of browser e2es the scheduled run must pass
 * (.github/workflows/web-e2e.yml). A name that no longer exists would quietly drop a file, and a
 * file that drives ego-browser cannot run on a CI runner at all (it operates a signed-in desktop
 * browser), so both are refused here rather than discovered on a red run.
 */
const entries = (await Bun.file("scripts/e2e/web-e2e-ci.txt").text())
  .split("\n")
  .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"))
  .map((line) => line.trim().split(/\s+/));
const tests = new Set<string>();
for await (const file of new Bun.Glob("**/*.e2e.ts").scan({
  cwd: "apps/web/test",
  onlyFiles: true,
}))
  tests.add(file);

test("every browser e2e is registered for CI or explicitly excluded with a reason", async () => {
  const path = "scripts/e2e/web-e2e-ci-excluded.txt";
  const excluded = Bun.file(path);
  expect(await excluded.exists(), path).toBe(true);
  const registered = new Set(entries.map(([file]) => file!));
  for (const line of (await excluded.text()).split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const [file, ...reason] = line.trim().split(/\s+/);
    expect(tests.has(file!), file).toBe(true);
    expect(registered.has(file!), `${file} is registered more than once`).toBe(false);
    expect(reason.join(" ").trim(), `${file} needs an exclusion reason`).not.toBe("");
    registered.add(file!);
  }
  expect([...tests].filter((file) => !registered.has(file)).sort()).toEqual([]);
});

test("every listed browser e2e exists, once, with the seconds that balance the shards", () => {
  // Non-vacuity: the list is not empty.
  expect(entries.length).toBeGreaterThan(10);
  for (const entry of entries) {
    expect(entry, entry.join(" ")).toHaveLength(2);
    const [file, seconds] = entry as [string, string];
    expect(tests.has(file), file).toBe(true);
    expect(Number(seconds), file).toBeGreaterThan(0);
  }
  const files = entries.map(([file]) => file);
  expect(new Set(files).size).toBe(files.length);
});

test("no listed browser e2e drives ego-browser", async () => {
  for (const [file] of entries) {
    const source = await Bun.file(`apps/web/test/${file}`).text();
    expect(source.includes("ego-browser"), file).toBe(false);
  }
});

test("the runner splits the list into six balanced shards that together hold every file once", async () => {
  const shardCount = 6;
  const shard = async (n: number) => {
    const child = Bun.spawn(
      ["bash", "scripts/e2e/run-web-e2e-ci.sh", String(n), String(shardCount), "--list"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code, `shard ${n}`).toBe(0);
    return stdout.split("\n").filter(Boolean);
  };
  const runnerScript = await Bun.file("scripts/e2e/run-web-e2e-ci.sh").text();
  const sweepSeedMatch = runnerScript.match(/^ui_sweep_seconds=(\d+)$/m);
  expect(sweepSeedMatch).not.toBeNull();
  const sweepSeed = Number(sweepSeedMatch![1]);

  const shards = await Promise.all(Array.from({ length: shardCount }, (_, i) => shard(i + 1)));
  for (const [index, list] of shards.entries()) {
    expect(list.length, `shard ${index + 1}`).toBeGreaterThan(0);
  }
  expect(shards.flat().sort()).toEqual(entries.map(([file]) => file!).sort());
  const seconds = new Map(entries.map(([file, s]) => [file!, Number(s)]));
  const loads = shards.map(
    (files, index) =>
      files.reduce((sum, file) => sum + seconds.get(file)!, 0) + (index === 0 ? sweepSeed : 0),
  );
  // Balanced: the heaviest shard (including shard 1's ui-sweep budget) stays within one longest file of the lightest.
  const longest = Math.max(...seconds.values());
  expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(longest);
});

test("E2E_FILE soaks one file on shard 1, E2E_REPEAT times, and leaves the other shards empty", async () => {
  const shardCount = 6;
  const list = async (n: number, env: Record<string, string>) => {
    const child = Bun.spawn(
      ["bash", "scripts/e2e/run-web-e2e-ci.sh", String(n), String(shardCount), "--list"],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...env },
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { lines: stdout.split("\n").filter(Boolean), stderr, code };
  };
  const file = entries[0]![0]!;
  const soak = await list(1, { E2E_FILE: file, E2E_REPEAT: "10" });
  expect(soak.code).toBe(0);
  expect(soak.lines).toEqual(Array.from({ length: 10 }, () => file));
  for (const n of [2, 3, 4, 5, 6]) {
    const other = await list(n, { E2E_FILE: file, E2E_REPEAT: "10" });
    expect(other.code, `shard ${n}`).toBe(0);
    expect(other.lines, `shard ${n}`).toEqual([]);
  }
  for (const bad of [
    { E2E_FILE: "../secrets.e2e.ts" },
    { E2E_FILE: "no-such-file.e2e.ts" },
    { E2E_FILE: file, E2E_REPEAT: "0" },
    { E2E_FILE: file, E2E_REPEAT: "100" },
  ]) {
    const refused = await list(1, bad);
    expect(refused.code, JSON.stringify(bad)).not.toBe(0);
    expect(refused.lines, JSON.stringify(bad)).toEqual([]);
  }
});

test("web-e2e.yml runs 6 non-blocking shards with Bun and pinned Chrome caches", async () => {
  type WorkflowStep = {
    id?: string;
    name?: string;
    uses?: string;
    if?: string;
    env?: Record<string, string>;
    run?: string;
    with?: Record<string, unknown>;
  };
  type WebE2eWorkflow = {
    on: Record<string, unknown>;
    jobs: {
      e2e: {
        name: string;
        strategy: { "fail-fast"?: boolean; matrix: { shard: string } };
        env: Record<string, string>;
        steps: WorkflowStep[];
      };
    };
  };
  const workflow = Bun.YAML.parse(
    await Bun.file(".github/workflows/web-e2e.yml").text(),
  ) as WebE2eWorkflow;
  const ciWorkflow = Bun.YAML.parse(await Bun.file(".github/workflows/ci.yml").text()) as {
    jobs: Record<string, { needs?: string[] }>;
  };

  expect(Object.keys(workflow.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
  expect(ciWorkflow.jobs["ci-passed"]?.needs ?? []).not.toContain("web-e2e");

  const job = workflow.jobs.e2e;
  expect(job.name).toContain("of 6");
  expect(job.strategy["fail-fast"]).toBe(false);
  expect(job.strategy.matrix.shard).toContain("[1, 2, 3, 4, 5, 6]");
  expect(job.strategy.matrix.shard).toContain("[1]");

  const steps = job.steps;
  const bunCache = steps.find((step) => step.name === "Cache Bun packages");
  const bunInstall = steps.find((step) => step.name === "Install dependencies");
  expect(bunCache?.uses).toStartWith("actions/cache@");
  expect(String(bunCache?.with?.path ?? "")).toBe("~/.bun/install/cache");
  expect(String(bunCache?.with?.path ?? "")).not.toContain("node_modules");
  expect(String(bunCache?.with?.key ?? "")).toContain("hashFiles('mise.toml', 'bun.lock')");
  expect(bunInstall?.run).toContain("bun install --frozen-lockfile");

  expect(job.env.AGENT_BROWSER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  const chromeLookup = steps.find((step) => step.id === "chrome-version");
  const browserCache = steps.find((step) => step.id === "agent-browser-cache");
  const browserInstall = steps.find((step) => step.name === "Install agent-browser and Chrome");
  expect(chromeLookup?.run).toContain("chrome-for-testing");
  expect(browserCache?.uses).toStartWith("actions/cache@");
  const cachePath = String(browserCache?.with?.path ?? "");
  expect(cachePath).toContain("~/.cache/agent-browser-cli");
  expect(cachePath).toContain("~/.agent-browser/browsers");
  expect(cachePath).not.toMatch(/apt|dpkg/);
  const cacheKey = String(browserCache?.with?.key ?? "");
  expect(cacheKey).toContain("runner.os");
  expect(cacheKey).toContain("runner.arch");
  expect(cacheKey).toContain("env.AGENT_BROWSER_VERSION");
  expect(cacheKey).toContain("steps.chrome-version.outputs.version");
  expect(browserInstall?.run).toContain("agent-browser install --with-deps");
  expect(browserInstall?.if).toBeUndefined();

  const runShard = steps.find((step) => step.name === "Run the shard");
  expect(runShard?.id).toBe("run-shard");
  expect(runShard?.run).toContain('run-web-e2e-ci.sh "${{ matrix.shard }}" 6');

  const summarize = steps.find((step) => step.name === "Summarize the shard");
  expect(summarize?.if).toBe("always()");
  expect(summarize?.env?.SHARDS).toBe("6");
  expect(summarize?.run).toContain("scripts/ci/web-e2e-summary.ts");
  expect(summarize?.run).toContain("summary.json");

  const summaryUpload = steps.find((step) => step.name === "Upload shard summary");
  expect(summaryUpload?.if).toBe("always()");
  expect(summaryUpload?.uses).toStartWith("actions/upload-artifact@");
  expect(String(summaryUpload?.with?.name ?? "")).toBe(
    "web-e2e-shard-${{ matrix.shard }}-of-6-summary",
  );
  const summaryPaths = String(summaryUpload?.with?.path ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  expect(summaryPaths).toEqual([
    "${{ env.E2E_OUTPUT }}/summary.md",
    "${{ env.E2E_OUTPUT }}/summary.json",
  ]);
  expect(summaryUpload?.with?.["if-no-files-found"]).toBe("ignore");
  expect(Number(summaryUpload?.with?.["retention-days"])).toBeGreaterThan(0);
  expect(Number(summaryUpload?.with?.["retention-days"])).toBeLessThanOrEqual(7);

  const upload = steps.find((step) => step.name === "Keep the output of a failed shard");
  expect(upload?.if).toBe("failure()");
  expect(String(upload?.with?.name ?? "")).toBe("web-e2e-shard-${{ matrix.shard }}-of-6");
  const failedPaths = String(upload?.with?.path ?? "");
  expect(failedPaths).toContain("${{ env.E2E_OUTPUT }}/logs");
  expect(failedPaths).toContain("${{ env.E2E_OUTPUT }}/screenshots");
  expect(failedPaths).toContain("${{ env.E2E_OUTPUT }}/ui-sweep");
  expect(failedPaths).toContain("${{ env.E2E_OUTPUT }}/summary.md");
});
