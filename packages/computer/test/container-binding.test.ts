import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import {
  attachRunningWorkspace,
  prepareContainerBinding,
  type RunningWorkspaceStart,
} from "#src/host/container-binding";
import { FileDaemonCredentialStore, workspaceStateDirectory } from "@lrm/coforge-daemon";

const daemonKey = `dk_${"b".repeat(43)}`;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "coforge-container-"));
  directories.push(directory);
  return directory;
}

const env = {
  COFORGE_DAEMON_API_KEY: daemonKey,
  COFORGE_WORKSPACE_ID: "workspace-1",
  COFORGE_WORKSPACE_SLUG: "alpha",
  COFORGE_COMPUTER_ID: "computer-1",
  COFORGE_COMPUTER_NAME: "lab",
  COFORGE_SERVER_URL: "https://server.example",
  COFORGE_REFRESH_TOKEN: "refresh-secret",
};

test("a container writes one workspace binding and the daemon key", async () => {
  const directory = await stateDirectory();
  expect(await prepareContainerBinding(env, directory)).toBe(true);
  const binding = await Bun.file(join(directory, "bindings.json")).json();
  expect(binding).toEqual([
    {
      workspaceId: "workspace-1",
      computerId: "computer-1",
      workspaceRoot: "/root/.coforge/agent-workspaces",
      serverHttpUrl: "https://server.example",
      enabled: true,
    },
  ]);
  const names = await files(directory);
  const keyFile = names.find((name) => name.endsWith(".api-key"));
  expect(keyFile).toBeDefined();
  expect((await Bun.file(keyFile!).text()).trim()).toBe(daemonKey);
  const written = await Promise.all(names.map(async (name) => Bun.file(name).text()));
  expect(written.join("\n")).not.toContain("refresh-secret");
  expect(written.join("\n")).not.toContain("alpha");
});

test("attaching a workspace starts only that workspace on the persisted volume", async () => {
  const directory = await stateDirectory();
  expect(await prepareContainerBinding(env, directory)).toBe(true);
  const started: string[] = [];
  expect(
    await attachRunningWorkspace(
      {
        ...env,
        COFORGE_WORKSPACE_ID: "workspace-2",
        COFORGE_DAEMON_API_KEY: `dk_${"c".repeat(43)}`,
      },
      directory,
      "https://server.example",
      async (config) => {
        started.push(config.workspaceId);
        expect(config).toEqual({
          workspaceId: "workspace-2",
          computerId: "computer-1",
          workspaceRoot: "/root/.coforge/agent-workspaces",
          daemonApiKey: `dk_${"c".repeat(43)}`,
          serverHttpUrl: "https://server.example",
        });
      },
    ),
  ).toBe(true);
  expect(started).toEqual(["workspace-2"]);
  const binding = await Bun.file(join(directory, "bindings.json")).json();
  expect(binding.map((item: { workspaceId: string }) => item.workspaceId)).toEqual([
    "workspace-1",
    "workspace-2",
  ]);
});

test("a second workspace is appended and the same workspace is not duplicated", async () => {
  const directory = await stateDirectory();
  expect(await prepareContainerBinding(env, directory)).toBe(true);
  expect(
    await prepareContainerBinding(
      {
        ...env,
        COFORGE_WORKSPACE_ID: "workspace-2",
        COFORGE_DAEMON_API_KEY: `dk_${"c".repeat(43)}`,
      },
      directory,
    ),
  ).toBe(true);
  expect(await prepareContainerBinding(env, directory)).toBe(true);
  const binding = await Bun.file(join(directory, "bindings.json")).json();
  expect(binding.map((item: { workspaceId: string }) => item.workspaceId)).toEqual([
    "workspace-1",
    "workspace-2",
  ]);
});

test("foreground without container environment leaves the state directory empty", async () => {
  const directory = await stateDirectory();
  expect(await prepareContainerBinding({}, directory)).toBe(false);
  expect(await files(directory)).toEqual([]);
});

test("a server URL from another build is refused before anything is written", async () => {
  const directory = await stateDirectory();
  await expect(prepareContainerBinding(env, directory, "https://other.example")).rejects.toThrow(
    "Binding server does not match this daemon build",
  );
  expect(await files(directory)).toEqual([]);
});

test("a partial container environment is refused before anything is written", async () => {
  const directory = await stateDirectory();
  await expect(
    prepareContainerBinding({ COFORGE_DAEMON_API_KEY: daemonKey }, directory),
  ).rejects.toThrow("container environment is incomplete");
  expect(await files(directory)).toEqual([]);
});

async function files(directory: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(path);
    }
  };
  await walk(directory);
  return found.sort();
}

test("a re-attach keeps a confirmed sk_computer over the env's dk_", async () => {
  const directory = await stateDirectory();
  const credentials = new FileDaemonCredentialStore(
    workspaceStateDirectory(directory, "workspace-1"),
  );
  const swapped = `sk_computer_${"s".repeat(43)}`;
  await credentials.save("workspace-1", "computer-1", swapped);
  await credentials.markConfirmed("workspace-1", "computer-1", swapped);
  expect(await prepareContainerBinding(env, directory)).toBe(true);
  // The env carried a fresh `dk_`; a confirmed `sk_computer` is the live machine key and wins.
  expect(await credentials.load("workspace-1", "computer-1")).toBe(swapped);
});

test("an unconfirmed sk_computer is kept: it still authenticates and the child re-confirms", async () => {
  const directory = await stateDirectory();
  const credentials = new FileDaemonCredentialStore(
    workspaceStateDirectory(directory, "workspace-1"),
  );
  const unconfirmed = `sk_computer_${"u".repeat(43)}`;
  await credentials.save("workspace-1", "computer-1", unconfirmed);
  expect(await prepareContainerBinding(env, directory)).toBe(true);
  // An sk_computer is a live `kind: "computer"` key until a later key event revokes it; the
  // child's migrateComputerKey confirms it on the next connect, so a dk_ must not replace it.
  expect(await credentials.load("workspace-1", "computer-1")).toBe(unconfirmed);
});

test("a reconnect attach replaces even a stored sk_computer with the env's fresh key", async () => {
  const directory = await stateDirectory();
  const credentials = new FileDaemonCredentialStore(
    workspaceStateDirectory(directory, "workspace-1"),
  );
  const revoked = `sk_computer_${"r".repeat(43)}`;
  await credentials.save("workspace-1", "computer-1", revoked);
  await credentials.markConfirmed("workspace-1", "computer-1", revoked);
  // The server refused this binding's credential, so the stored key may itself be the revoked
  // one: COFORGE_REPLACE_CREDENTIAL makes the fresh attach key win over any stored credential.
  expect(
    await prepareContainerBinding({ ...env, COFORGE_REPLACE_CREDENTIAL: "1" }, directory),
  ).toBe(true);
  expect(await credentials.load("workspace-1", "computer-1")).toBe(daemonKey);
});

test("a foreground restart seeds the env key only into an empty credential store", async () => {
  const directory = await stateDirectory();
  const credentials = new FileDaemonCredentialStore(
    workspaceStateDirectory(directory, "workspace-1"),
  );
  // The service env carries the create job's original dk_, long revoked by confirm-key: on a
  // restart it must never overwrite whatever credential the binding already holds (task #572).
  await credentials.save("workspace-1", "computer-1", `dk_${"a".repeat(43)}`);
  expect(await prepareContainerBinding(env, directory, undefined, { seedOnly: true })).toBe(true);
  expect(await credentials.load("workspace-1", "computer-1")).toBe(`dk_${"a".repeat(43)}`);
  await credentials.save("workspace-1", "computer-1", `sk_computer_${"s".repeat(43)}`);
  expect(await prepareContainerBinding(env, directory, undefined, { seedOnly: true })).toBe(true);
  expect(await credentials.load("workspace-1", "computer-1")).toBe(`sk_computer_${"s".repeat(43)}`);
});

test("a foreground restart with no stored credential seeds the env key", async () => {
  const directory = await stateDirectory();
  expect(await prepareContainerBinding(env, directory, undefined, { seedOnly: true })).toBe(true);
  const credentials = new FileDaemonCredentialStore(
    workspaceStateDirectory(directory, "workspace-1"),
  );
  expect(await credentials.load("workspace-1", "computer-1")).toBe(daemonKey);
});

test("a stored dk_ is still replaced by the env's key on attach", async () => {
  const directory = await stateDirectory();
  const credentials = new FileDaemonCredentialStore(
    workspaceStateDirectory(directory, "workspace-1"),
  );
  await credentials.save("workspace-1", "computer-1", `dk_${"a".repeat(43)}`);
  expect(await prepareContainerBinding(env, directory)).toBe(true);
  expect(await credentials.load("workspace-1", "computer-1")).toBe(daemonKey);
});

test("attach starts the workspace with the credential the file actually holds", async () => {
  const directory = await stateDirectory();
  const credentials = new FileDaemonCredentialStore(
    workspaceStateDirectory(directory, "workspace-1"),
  );
  const swapped = `sk_computer_${"s".repeat(43)}`;
  await credentials.save("workspace-1", "computer-1", swapped);
  await credentials.markConfirmed("workspace-1", "computer-1", swapped);
  const configs: RunningWorkspaceStart[] = [];
  expect(
    await attachRunningWorkspace(env, directory, "https://server.example", async (config) => {
      configs.push(config);
    }),
  ).toBe(true);
  // The env's `dk_` lost to the confirmed `sk_computer` in the file; configure must carry the
  // same key the file holds, or the supervisor's adopt writes the attach's key back over it —
  // a key confirm-key may already have revoked (task #572).
  expect(configs).toEqual([
    {
      workspaceId: "workspace-1",
      computerId: "computer-1",
      workspaceRoot: "/root/.coforge/agent-workspaces",
      daemonApiKey: swapped,
      serverHttpUrl: "https://server.example",
    },
  ]);
});

test("preparing the live container environment marks the process as a cloud computer", async () => {
  const directory = await stateDirectory();
  const saved = process.env.COFORGE_COMPUTER_CLOUD;
  const savedKeys = Object.keys(env).map((key) => [key, process.env[key]] as const);
  delete process.env.COFORGE_COMPUTER_CLOUD;
  try {
    Object.assign(process.env, env);
    expect(await prepareContainerBinding(process.env, directory)).toBe(true);
    expect(process.env.COFORGE_COMPUTER_CLOUD ?? "").toBe("1");
  } finally {
    if (saved === undefined) delete process.env.COFORGE_COMPUTER_CLOUD;
    else process.env.COFORGE_COMPUTER_CLOUD = saved;
    for (const [key, value] of savedKeys) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a snapshot environment does not mark the running process", async () => {
  const directory = await stateDirectory();
  const saved = process.env.COFORGE_COMPUTER_CLOUD;
  delete process.env.COFORGE_COMPUTER_CLOUD;
  try {
    expect(await prepareContainerBinding(env, directory)).toBe(true);
    expect(process.env.COFORGE_COMPUTER_CLOUD).toBeUndefined();
  } finally {
    if (saved === undefined) delete process.env.COFORGE_COMPUTER_CLOUD;
    else process.env.COFORGE_COMPUTER_CLOUD = saved;
  }
});
