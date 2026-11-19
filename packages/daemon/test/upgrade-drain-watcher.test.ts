import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UPGRADE_DRAIN_MAX_TTL_MS,
  UPGRADE_DRAIN_REQUEST_FILE,
  UPGRADE_DRAIN_STATE_FILE,
  UpgradeDrainWatcher,
} from "#src/supervisor/upgrade-drain-watcher";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("UpgradeDrainWatcher", () => {
  test("engages hold, publishes live busyCount to state file, and releases when request file is removed", async () => {
    const dir = await makeTempDir("coforge-upgrade-drain-");
    let nowMs = 1_760_000_000_000;
    let busyCount = 2;
    const holdCalls: string[] = [];
    let releaseCalls = 0;

    const watcher = new UpgradeDrainWatcher({
      stateDirectory: dir,
      now: () => nowMs,
      hold: async (reason) => {
        holdCalls.push(reason);
        return { busyCount };
      },
      release: async () => {
        releaseCalls += 1;
      },
    });

    await watcher.pollOnce();
    expect(holdCalls).toEqual([]);
    expect(await Bun.file(join(dir, UPGRADE_DRAIN_STATE_FILE)).exists()).toBe(false);

    await writeFile(
      join(dir, UPGRADE_DRAIN_REQUEST_FILE),
      JSON.stringify({
        schemaVersion: 1,
        drainId: "req-upgrade-1",
        reason: "upgrade",
        requestedAtMs: nowMs,
        deadlineAtMs: nowMs + 120_000,
      }),
    );

    await watcher.pollOnce();
    expect(holdCalls).toEqual(["upgrade"]);
    expect(releaseCalls).toBe(0);
    expect(await Bun.file(join(dir, UPGRADE_DRAIN_STATE_FILE)).json()).toEqual({
      schemaVersion: 1,
      drainId: "req-upgrade-1",
      held: true,
      busyCount: 2,
      updatedAtMs: nowMs,
    });

    busyCount = 0;
    nowMs += 250;
    await watcher.pollOnce();
    expect(await Bun.file(join(dir, UPGRADE_DRAIN_STATE_FILE)).json()).toEqual({
      schemaVersion: 1,
      drainId: "req-upgrade-1",
      held: true,
      busyCount: 0,
      updatedAtMs: nowMs,
    });

    await rm(join(dir, UPGRADE_DRAIN_REQUEST_FILE));
    nowMs += 250;
    await watcher.pollOnce();
    expect(releaseCalls).toBe(1);
    expect(await Bun.file(join(dir, UPGRADE_DRAIN_STATE_FILE)).exists()).toBe(false);
  });

  test("auto-releases hold when request deadline expires or exceeds max TTL", async () => {
    const dir = await makeTempDir("coforge-upgrade-drain-expiry-");
    let nowMs = 1_760_000_000_000;
    let releaseCalls = 0;

    const watcher = new UpgradeDrainWatcher({
      stateDirectory: dir,
      now: () => nowMs,
      hold: async () => ({ busyCount: 1 }),
      release: async () => {
        releaseCalls += 1;
      },
    });

    await writeFile(
      join(dir, UPGRADE_DRAIN_REQUEST_FILE),
      JSON.stringify({
        schemaVersion: 1,
        drainId: "req-upgrade-2",
        reason: "upgrade",
        requestedAtMs: nowMs,
        deadlineAtMs: nowMs + 60_000,
      }),
    );
    await watcher.pollOnce();
    expect(await Bun.file(join(dir, UPGRADE_DRAIN_STATE_FILE)).exists()).toBe(true);

    nowMs += 60_000;
    await watcher.pollOnce();
    expect(releaseCalls).toBe(1);
    expect(await Bun.file(join(dir, UPGRADE_DRAIN_STATE_FILE)).exists()).toBe(false);
  });

  test("ignores symlinked request files and corrupt JSON without engaging hold", async () => {
    const dir = await makeTempDir("coforge-upgrade-drain-symlink-");
    const target = join(dir, "real.json");
    await writeFile(
      target,
      JSON.stringify({
        schemaVersion: 1,
        drainId: "req-sym",
        reason: "upgrade",
        requestedAtMs: 1_760_000_000_000,
        deadlineAtMs: 1_760_000_120_000,
      }),
    );
    await symlink(target, join(dir, UPGRADE_DRAIN_REQUEST_FILE));

    let holdCalls = 0;
    const watcher = new UpgradeDrainWatcher({
      stateDirectory: dir,
      now: () => 1_760_000_000_000,
      hold: async () => {
        holdCalls += 1;
        return { busyCount: 0 };
      },
      release: async () => {},
    });

    await watcher.pollOnce();
    expect(holdCalls).toBe(0);
    expect((await lstat(join(dir, UPGRADE_DRAIN_REQUEST_FILE))).isSymbolicLink()).toBe(true);

    await rm(join(dir, UPGRADE_DRAIN_REQUEST_FILE));
    await writeFile(join(dir, UPGRADE_DRAIN_REQUEST_FILE), "{bad json");
    await watcher.pollOnce();
    expect(holdCalls).toBe(0);
  });

  test("caps effective deadline at max TTL and does not release on stop()", async () => {
    const dir = await makeTempDir("coforge-upgrade-drain-cap-");
    let nowMs = 1_760_000_000_000;
    let releaseCalls = 0;

    const watcher = new UpgradeDrainWatcher({
      stateDirectory: dir,
      now: () => nowMs,
      hold: async () => ({ busyCount: 1 }),
      release: async () => {
        releaseCalls += 1;
      },
    });

    await writeFile(
      join(dir, UPGRADE_DRAIN_REQUEST_FILE),
      JSON.stringify({
        schemaVersion: 1,
        drainId: "req-cap",
        reason: "upgrade",
        requestedAtMs: nowMs,
        deadlineAtMs: nowMs + 60 * 60_000,
      }),
    );
    await watcher.pollOnce();
    expect(await Bun.file(join(dir, UPGRADE_DRAIN_STATE_FILE)).exists()).toBe(true);

    nowMs += UPGRADE_DRAIN_MAX_TTL_MS;
    await watcher.pollOnce();
    expect(releaseCalls).toBe(1);
    expect(await Bun.file(join(dir, UPGRADE_DRAIN_STATE_FILE)).exists()).toBe(false);

    await writeFile(
      join(dir, UPGRADE_DRAIN_REQUEST_FILE),
      JSON.stringify({
        schemaVersion: 1,
        drainId: "req-stop",
        reason: "upgrade",
        requestedAtMs: nowMs,
        deadlineAtMs: nowMs + 60_000,
      }),
    );
    await watcher.pollOnce();
    watcher.stop();
    expect(releaseCalls).toBe(1);
  });

  test("refuses to overwrite a symlinked state file", async () => {
    const dir = await makeTempDir("coforge-upgrade-drain-state-sym-");
    const victim = join(dir, "victim.txt");
    await writeFile(victim, "keep");
    await symlink(victim, join(dir, UPGRADE_DRAIN_STATE_FILE));
    const nowMs = 1_760_000_000_000;
    await writeFile(
      join(dir, UPGRADE_DRAIN_REQUEST_FILE),
      JSON.stringify({
        schemaVersion: 1,
        drainId: "req-victim",
        reason: "upgrade",
        requestedAtMs: nowMs,
        deadlineAtMs: nowMs + 60_000,
      }),
    );

    const watcher = new UpgradeDrainWatcher({
      stateDirectory: dir,
      now: () => nowMs,
      hold: async () => ({ busyCount: 0 }),
      release: async () => {},
    });

    await watcher.pollOnce();
    expect(await Bun.file(victim).text()).toBe("keep");
    expect((await lstat(join(dir, UPGRADE_DRAIN_STATE_FILE))).isSymbolicLink()).toBe(true);
  });

  test("does not write state file or release if stopped or request removed while hold is in flight", async () => {
    const dir = await makeTempDir("coforge-upgrade-drain-race-");
    const nowMs = 1_760_000_000_000;
    await writeFile(
      join(dir, UPGRADE_DRAIN_REQUEST_FILE),
      JSON.stringify({
        schemaVersion: 1,
        drainId: "req-race-stop",
        reason: "upgrade",
        requestedAtMs: nowMs,
        deadlineAtMs: nowMs + 60_000,
      }),
    );

    let resolveHold: ((value: { busyCount: number }) => void) | undefined;
    let releaseCalls = 0;
    const watcher = new UpgradeDrainWatcher({
      stateDirectory: dir,
      now: () => nowMs,
      hold: () =>
        new Promise((resolve) => {
          resolveHold = resolve;
        }),
      release: async () => {
        releaseCalls += 1;
      },
    });

    const inFlight = watcher.pollOnce();
    await Bun.sleep(10);
    watcher.stop();
    resolveHold!({ busyCount: 1 });
    await inFlight;
    expect(await Bun.file(join(dir, UPGRADE_DRAIN_STATE_FILE)).exists()).toBe(false);
    expect(releaseCalls).toBe(0);

    let resolveHold2: ((value: { busyCount: number }) => void) | undefined;
    const watcher2 = new UpgradeDrainWatcher({
      stateDirectory: dir,
      now: () => nowMs,
      hold: () =>
        new Promise((resolve) => {
          resolveHold2 = resolve;
        }),
      release: async () => {
        releaseCalls += 1;
      },
    });

    const inFlight2 = watcher2.pollOnce();
    await Bun.sleep(10);
    await rm(join(dir, UPGRADE_DRAIN_REQUEST_FILE));
    resolveHold2!({ busyCount: 0 });
    await inFlight2;
    expect(await Bun.file(join(dir, UPGRADE_DRAIN_STATE_FILE)).exists()).toBe(false);
  });
});
