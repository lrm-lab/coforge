import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverCodeAgentCatalogs,
  discoverCodeAgentInventory,
} from "#src/code-agent/runtime-inventory";
import type { ExternalCodeAgentProbe } from "#src/code-agent/runtime-executable";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";

test("the Droid catalog probe runs from the Daemon's own directory, not the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "daemon-droid-catalog-"));
  const workspace = join(root, "workspace");
  const cacheDirectory = join(root, "daemon-state");
  const log = join(root, "rpc.jsonl");
  const probe: ExternalCodeAgentProbe = {
    which: (name) => (name === "droid" ? "/bin/droid" : undefined),
    spawn: () => ({
      stdout: new Blob(["1.4.1\n"]).stream(),
      exited: Promise.resolve(0),
    }),
  };
  try {
    const inventory = await discoverCodeAgentInventory({
      probe,
      commands: { droid: [process.execPath, anvilRuntimeFixtures.droid] },
      cwd: workspace,
      cacheDirectory,
      environment: { HOME: "/fixture/home", PATH: "", PI_OFFLINE: "1", DROID_ACP_FIXTURE_LOG: log },
      piModels: async () => [],
    });
    expect(inventory.catalogs.find((catalog) => catalog.provider === "droid")).toMatchObject({
      provider: "droid",
      models: [
        expect.objectContaining({ id: "auto" }),
        expect.objectContaining({ id: "claude-sonnet-5" }),
        expect.objectContaining({ id: "gpt-6.1-sol" }),
      ],
    });
    // Droid keeps a session per cwd and cannot delete it, so the probe must not run from the
    // user's workspace.
    const first = JSON.parse((await readFile(log, "utf8")).split("\n")[0]!) as { cwd: string };
    expect(first.cwd).toMatch(/daemon-state\/droid-catalog-probe$/);
    expect(first.cwd).not.toContain("workspace");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Droid probe that returns no catalog is a retryable discovery failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "daemon-droid-catalog-failure-"));
  try {
    const result = await discoverCodeAgentCatalogs(
      [{ provider: "droid", version: "1.4.1", displayName: "Droid" }],
      {
        probe: {
          which: (name) => (name === "droid" ? "/bin/droid" : undefined),
          spawn: () => ({
            stdout: new Blob(["1.4.1\n"]).stream(),
            exited: Promise.resolve(0),
          }),
        },
        commands: { droid: [process.execPath, anvilRuntimeFixtures.droid] },
        cwd: root,
        cacheDirectory: join(root, "daemon-state"),
        environment: {
          HOME: "/fixture/home",
          PATH: "",
          PI_OFFLINE: "1",
          DROID_ACP_FIXTURE_REQUIRE_LOGIN: "1",
        },
        piModels: async () => [],
      },
    );
    expect(result.catalogs.find((catalog) => catalog.provider === "droid")).toBeUndefined();
    expect(result.failures).toEqual([{ provider: "droid", code: "unknown" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
