import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireProcessLock } from "#src/platform/process-lock";
import { holdWorkspaceDaemonLock } from "#src/supervisor/workspace-daemon-lock";

const directories: string[] = [];
const locks: { release(): void }[] = [];

async function stateDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "coforge-binding-lock-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const lock of locks.splice(0)) lock.release();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("holdWorkspaceDaemonLock", () => {
  test("takes the binding's lock when nothing holds it", async () => {
    const directory = await stateDirectory();
    const lock = await holdWorkspaceDaemonLock(directory, { retryMs: 5 });
    locks.push(lock);
    expect(typeof lock.release).toBe("function");
  });

  test("waits for a live holder, then takes over when it exits", async () => {
    const directory = await stateDirectory();
    const holder = acquireProcessLock(join(directory, "workspace-daemon-lock.sqlite"));
    locks.push(holder);

    let waiting = false;
    const pending = holdWorkspaceDaemonLock(directory, {
      retryMs: 5,
      waiting: () => {
        waiting = true;
      },
    });
    // Still waiting while the holder lives.
    const early = await Promise.race([
      pending.then(() => "acquired"),
      Bun.sleep(60).then(() => "waiting"),
    ]);
    expect(early).toBe("waiting");
    expect(waiting).toBe(true);

    holder.release();
    locks.splice(locks.indexOf(holder), 1);
    const lock = await pending;
    locks.push(lock);
  });

  test("a second contender in another directory is not blocked", async () => {
    const first = await stateDirectory();
    const second = await stateDirectory();
    locks.push(acquireProcessLock(join(first, "workspace-daemon-lock.sqlite")));
    const lock = await holdWorkspaceDaemonLock(second, { retryMs: 5 });
    locks.push(lock);
  });

  test("an aborted wait rejects instead of acquiring", async () => {
    const directory = await stateDirectory();
    locks.push(acquireProcessLock(join(directory, "workspace-daemon-lock.sqlite")));
    const controller = new AbortController();
    const pending = holdWorkspaceDaemonLock(directory, {
      retryMs: 5,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });
});
