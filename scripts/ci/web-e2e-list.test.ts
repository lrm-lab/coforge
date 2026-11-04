import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

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
const tests = new Set((await readdir("apps/web/test")).filter((name) => name.endsWith(".e2e.ts")));

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

test("the runner splits the list into shards that together hold every file once", async () => {
  const shard = async (n: number) => {
    const child = Bun.spawn(["bash", "scripts/e2e/run-web-e2e-ci.sh", String(n), "2", "--list"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code, `shard ${n}`).toBe(0);
    return stdout.split("\n").filter(Boolean);
  };
  const [first, second] = [await shard(1), await shard(2)];
  expect(first.length).toBeGreaterThan(0);
  expect(second.length).toBeGreaterThan(0);
  expect([...first, ...second].sort()).toEqual(entries.map(([file]) => file!).sort());
  const seconds = new Map(entries.map(([file, s]) => [file!, Number(s)]));
  const load = (files: string[]) => files.reduce((sum, file) => sum + seconds.get(file)!, 0);
  // Balanced: neither shard carries more than the other plus its longest file.
  const longest = Math.max(...seconds.values());
  expect(Math.abs(load(first) - load(second))).toBeLessThanOrEqual(longest);
});
