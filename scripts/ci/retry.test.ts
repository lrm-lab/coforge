import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// retry.sh re-runs a flaky download command with exponential backoff; delay 0
// keeps the test instant while still exercising the attempt loop.

const run = async (script: string, attempts: number) => {
  const dir = await mkdtemp(join(tmpdir(), "coforge-retry-"));
  try {
    const counter = join(dir, "count");
    await writeFile(counter, "");
    const result = Bun.spawnSync(
      ["bash", "scripts/ci/retry.sh", String(attempts), "0", "--", "bash", "-c", script],
      { env: { ...Bun.env, COUNTER: counter } },
    );
    return {
      code: result.exitCode,
      count: Number((await readFile(counter, "utf8")).trim().split("\n").filter(Boolean).length),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test("retry.sh succeeds once the command stops failing", async () => {
  const { code, count } = await run(
    'n=$(wc -l < "$COUNTER"); echo "$n" >> "$COUNTER"; [ "$n" -ge 2 ]',
    5,
  );
  expect(code).toBe(0);
  expect(count).toBe(3);
});

test("retry.sh gives up after the attempt budget", async () => {
  const { code, count } = await run('echo x >> "$COUNTER"; exit 1', 3);
  expect(code).toBe(1);
  expect(count).toBe(3);
});
