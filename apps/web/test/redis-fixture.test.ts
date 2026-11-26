import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRedisFixture } from "./helpers/redis-fixture";

test("a Redis process that exits before readiness reports its exit and removes its directory", async () => {
  const parentDirectory = await mkdtemp(join(tmpdir(), "rf-"));
  try {
    const command = [process.execPath, "-e", "process.exit(17)"];
    await expect(startRedisFixture({ command, parentDirectory })).rejects.toThrow(
      "exited with code 17",
    );
    expect(await readdir(parentDirectory)).toEqual([]);
  } finally {
    await rm(parentDirectory, { recursive: true, force: true });
  }
}, 25_000);

test("a Redis process that never becomes ready is stopped and its directory is removed", async () => {
  const parentDirectory = await mkdtemp(join(tmpdir(), "rf-"));
  try {
    const pidPath = join(parentDirectory, "pid");
    const command = [
      "/bin/sh",
      "-c",
      'trap "" TERM; printf "%s" "$$" > "$1"; exec sleep 30',
      "redis-fixture",
      pidPath,
    ];
    await expect(
      startRedisFixture({ command, parentDirectory, startupTimeoutMs: 500 }),
    ).rejects.toThrow("did not become ready");
    const pid = Number(await Bun.file(pidPath).text());
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    expect(await readdir(parentDirectory)).toEqual(["pid"]);
  } finally {
    await rm(parentDirectory, { recursive: true, force: true });
  }
}, 10_000);
