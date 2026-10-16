import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { attachRunningWorkspace, prepareContainerBinding } from "#src/host/container-binding";

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
