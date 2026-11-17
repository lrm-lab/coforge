import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireProcessLock } from "#src/platform/process-lock";
import {
  holdWorkspaceDaemonLock,
  readWorkspaceDaemonLockHolder,
} from "#src/supervisor/workspace-daemon-lock";

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

  test("readWorkspaceDaemonLockHolder reports the live holder PID without breaking contender takeover", async () => {
    const directory = await stateDirectory();
    expect(await readWorkspaceDaemonLockHolder(directory)).toEqual({
      held: false,
      holderPid: null,
    });

    const first = await holdWorkspaceDaemonLock(directory, { retryMs: 5, pid: 4101 });
    locks.push(first);
    expect(await readWorkspaceDaemonLockHolder(directory)).toEqual({
      held: true,
      holderPid: 4101,
    });

    const contender = holdWorkspaceDaemonLock(directory, { retryMs: 10, pid: 4102 });
    await Bun.sleep(25);
    // Probing while a contender waits must keep the first holder and leave the contender waiting.
    expect(await readWorkspaceDaemonLockHolder(directory)).toEqual({
      held: true,
      holderPid: 4101,
    });

    first.release();
    locks.splice(locks.indexOf(first), 1);
    const second = await contender;
    locks.push(second);
    expect(await readWorkspaceDaemonLockHolder(directory)).toEqual({
      held: true,
      holderPid: 4102,
    });

    second.release();
    locks.splice(locks.indexOf(second), 1);
    // Even if an abrupt crash left an owner file behind, an unheld SQLite lock reads as free.
    await Bun.write(join(directory, "workspace-daemon-lock.owner"), "9999");
    expect(await readWorkspaceDaemonLockHolder(directory)).toEqual({
      held: false,
      holderPid: null,
    });
  });
});
