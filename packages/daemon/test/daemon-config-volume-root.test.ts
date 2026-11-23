import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonConfigStore, reachableWorkspaceRoot } from "#src/persistence/daemon-config";

test("the workspace root is addressed through the volume root the uid can reach", () => {
  expect(reachableWorkspaceRoot("/root/.coforge/agent-workspaces", "/srv/coforge")).toBe(
    "/srv/coforge/agent-workspaces",
  );
  expect(reachableWorkspaceRoot("/root/.coforge/agent-workspaces", undefined)).toBe(
    "/root/.coforge/agent-workspaces",
  );
  expect(reachableWorkspaceRoot("/srv/other/place", "/srv/coforge")).toBe("/srv/other/place");
});

test("a loaded binding names the reachable workspace root, the file is left alone", async () => {
  const state = await mkdtemp(join(tmpdir(), "coforge-config-"));
  const path = join(state, "config.json");
  await writeFile(
    path,
    JSON.stringify({
      workspaceId: "workspace",
      computerId: "computer",
      workspaceRoot: "/root/.coforge/agent-workspaces",
      serverHttpUrl: "https://server.example",
      restartRequestIds: [],
      upgradeRequestIds: [],
      upgradeExpectedVersions: {},
      upgradeOperations: [],
    }),
  );
  const previous = process.env.COFORGE_WORKSPACE_VOLUME_ROOT;
  process.env.COFORGE_WORKSPACE_VOLUME_ROOT = "/srv/coforge";
  try {
    const config = await new DaemonConfigStore(state).load();
    expect(config?.workspaceRoot).toBe("/srv/coforge/agent-workspaces");
    const onDisk = JSON.parse(await readFile(path, "utf8"));
    expect(onDisk.workspaceRoot).toBe("/root/.coforge/agent-workspaces");
  } finally {
    if (previous === undefined) delete process.env.COFORGE_WORKSPACE_VOLUME_ROOT;
    else process.env.COFORGE_WORKSPACE_VOLUME_ROOT = previous;
  }
});
