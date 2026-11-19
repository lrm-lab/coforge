import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireProcessLock } from "#src/platform/process-lock";
import {
  acquireComputerKeyClaim,
  computerKeyFingerprint,
  DuplicateComputerKeyError,
} from "#src/supervisor/computer-key-claim";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("acquireComputerKeyClaim", () => {
  test("blocks a second install directory using the same Computer API key without leaking the secret", async () => {
    const claimDirectory = await makeTempDir("coforge-key-claims-");
    const secretKey = "cf_daemon_super_secret_token_value_12345";
    const first = await acquireComputerKeyClaim({
      apiKey: secretKey,
      stateDirectory: "/opt/coforge-a/daemon/workspaces/ws-1",
      workspaceId: "ws-1",
      computerId: "comp-1",
      version: "1.2.3",
      claimDirectory,
      pid: 4242,
    });
    expect(first).not.toBeNull();

    try {
      const fp = computerKeyFingerprint(`  ${secretKey}\n`);
      expect(fp).toBe(computerKeyFingerprint(secretKey));
      const claimRaw = await readFile(join(claimDirectory, `${fp}.claim.json`), "utf8");
      expect(claimRaw).not.toContain(secretKey);
      expect(JSON.parse(claimRaw)).toMatchObject({
        schemaVersion: 1,
        pid: 4242,
        version: "1.2.3",
        stateDirectory: "/opt/coforge-a/daemon/workspaces/ws-1",
        workspaceId: "ws-1",
        computerId: "comp-1",
      });

      let caught: unknown;
      try {
        await acquireComputerKeyClaim({
          apiKey: secretKey,
          stateDirectory: "/opt/coforge-b/daemon/workspaces/ws-1",
          workspaceId: "ws-1",
          computerId: "comp-1",
          version: "1.2.4",
          claimDirectory,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(DuplicateComputerKeyError);
      const err = caught as DuplicateComputerKeyError;
      expect(err.code).toBe("duplicate_computer_key");
      expect(err.holder?.pid).toBe(4242);
      expect(err.holder?.stateDirectory).toBe("/opt/coforge-a/daemon/workspaces/ws-1");
      expect(err.message).toContain("4242");
      expect(err.message).toContain("/opt/coforge-a/daemon/workspaces/ws-1");
      expect(err.message).toContain(fp.slice(0, 12));
      expect(err.message).not.toContain(secretKey);
    } finally {
      first?.release();
    }

    const secondAfterRelease = await acquireComputerKeyClaim({
      apiKey: secretKey,
      stateDirectory: "/opt/coforge-b/daemon/workspaces/ws-1",
      workspaceId: "ws-1",
      computerId: "comp-1",
      version: "1.2.4",
      claimDirectory,
    });
    expect(secondAfterRelease).not.toBeNull();
    secondAfterRelease?.release();
  });

  test("allows distinct API keys concurrently and retries briefly on same-directory handoff or missing metadata", async () => {
    const claimDirectory = await makeTempDir("coforge-key-claims-multi-");
    const first = await acquireComputerKeyClaim({
      apiKey: "key-alpha",
      stateDirectory: "/opt/coforge/ws-a",
      workspaceId: "ws-a",
      computerId: "comp-a",
      version: "1.0.0",
      claimDirectory,
    });
    const second = await acquireComputerKeyClaim({
      apiKey: "key-beta",
      stateDirectory: "/opt/coforge/ws-b",
      workspaceId: "ws-b",
      computerId: "comp-b",
      version: "1.0.0",
      claimDirectory,
    });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    setTimeout(() => first?.release(), 80);
    const handoff = await acquireComputerKeyClaim({
      apiKey: "key-alpha",
      stateDirectory: "/opt/coforge/ws-a",
      workspaceId: "ws-a",
      computerId: "comp-a",
      version: "1.0.1",
      claimDirectory,
      sameDirectoryRetryMs: 1_000,
      retryIntervalMs: 25,
    });
    expect(handoff).not.toBeNull();
    handoff?.release();
    second?.release();

    const transientKey = "key-transient-meta";
    const transientFp = computerKeyFingerprint(transientKey);
    const rawLock = acquireProcessLock(join(claimDirectory, `${transientFp}.lock.sqlite`));
    setTimeout(() => rawLock.release(), 60);
    const acquired = await acquireComputerKeyClaim({
      apiKey: transientKey,
      stateDirectory: "/opt/coforge/ws-t",
      workspaceId: "ws-t",
      computerId: "comp-t",
      version: "1.0.0",
      claimDirectory,
      sameDirectoryRetryMs: 500,
      retryIntervalMs: 20,
    });
    expect(acquired).not.toBeNull();
    acquired?.release();
  });

  test("refuses symlinked claim directory and symlinked lockPath without touching targets", async () => {
    const root = await makeTempDir("coforge-key-claims-sym-");
    const realFile = join(root, "real");
    const linkDir = join(root, "link");
    await writeFile(realFile, "not-a-dir");
    await symlink(realFile, linkDir);

    const claim = await acquireComputerKeyClaim({
      apiKey: "key-sym",
      stateDirectory: "/opt/coforge/ws-sym",
      workspaceId: "ws-sym",
      computerId: "comp-sym",
      version: "1.0.0",
      claimDirectory: linkDir,
    });
    expect(claim).toBeNull();
    expect((await lstat(linkDir)).isSymbolicLink()).toBe(true);

    const claimDir = await makeTempDir("coforge-key-claims-locksym-");
    const victim = join(root, "victim.txt");
    await writeFile(victim, "preserve");
    const fp = computerKeyFingerprint("key-lock-sym");
    await symlink(victim, join(claimDir, `${fp}.lock.sqlite`));

    const lockSymClaim = await acquireComputerKeyClaim({
      apiKey: "key-lock-sym",
      stateDirectory: "/opt/coforge/ws-locksym",
      workspaceId: "ws-locksym",
      computerId: "comp-locksym",
      version: "1.0.0",
      claimDirectory: claimDir,
    });
    expect(lockSymClaim).toBeNull();
    expect(await readFile(victim, "utf8")).toBe("preserve");
  });
});
