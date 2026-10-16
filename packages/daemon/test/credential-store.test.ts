import { afterEach, expect, test } from "bun:test";
import { FileDaemonCredentialStore } from "#src/credentials/credential-store";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("Daemon credential stores capture default directories and keep explicit directories independent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-daemon-credentials-"));
  directories.push(directory);
  const firstDirectory = join(directory, "first");
  const secondDirectory = join(directory, "second");
  const explicitDirectory = join(directory, "explicit");
  const previousHome = Bun.env.COFORGE_DAEMON_HOME;
  try {
    Bun.env.COFORGE_DAEMON_HOME = firstDirectory;
    const first = new FileDaemonCredentialStore();
    Bun.env.COFORGE_DAEMON_HOME = secondDirectory;
    const second = new FileDaemonCredentialStore();
    const explicit = new FileDaemonCredentialStore(explicitDirectory);
    Bun.env.COFORGE_DAEMON_HOME = explicitDirectory;

    await first.save("workspace-a", "computer-a", "test-first");
    await second.save("workspace-a", "computer-a", "test-second");
    await explicit.save("workspace-a", "computer-a", "test-explicit");
    await expect(
      new FileDaemonCredentialStore(firstDirectory).load("workspace-a", "computer-a"),
    ).resolves.toBe("test-first");
    await expect(
      new FileDaemonCredentialStore(secondDirectory).load("workspace-a", "computer-a"),
    ).resolves.toBe("test-second");
    await expect(
      new FileDaemonCredentialStore(explicitDirectory).load("workspace-a", "computer-a"),
    ).resolves.toBe("test-explicit");
    await expect(first.load("workspace-a", "computer-a")).resolves.toBe("test-first");

    await first.delete("workspace-a", "computer-a");
    await expect(
      new FileDaemonCredentialStore(firstDirectory).load("workspace-a", "computer-a"),
    ).resolves.toBeNull();
    await expect(second.load("workspace-a", "computer-a")).resolves.toBe("test-second");
    await expect(explicit.load("workspace-a", "computer-a")).resolves.toBe("test-explicit");
  } finally {
    if (previousHome === undefined) delete Bun.env.COFORGE_DAEMON_HOME;
    else Bun.env.COFORGE_DAEMON_HOME = previousHome;
  }
});

test("Daemon credential store persists a private API key file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-daemon-credentials-"));
  directories.push(directory);
  const store = new FileDaemonCredentialStore(directory);

  await store.save("workspace-a", "computer-a", "daemon-runtime-secret");
  await expect(store.load("workspace-a", "computer-a")).resolves.toBe("daemon-runtime-secret");
  const path = join(directory, "credentials", "workspace-a-computer-a.api-key");
  await expect(readFile(path, "utf8")).resolves.toBe("daemon-runtime-secret\n");
  await expect(stat(path)).resolves.toMatchObject({ mode: 0o100600 });
  await store.delete("workspace-a", "computer-a");
  await expect(store.load("workspace-a", "computer-a")).resolves.toBeNull();
});
