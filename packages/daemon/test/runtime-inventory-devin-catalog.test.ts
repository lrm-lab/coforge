import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCodeAgentInventory } from "#src/code-agent/runtime-inventory";
import type { ExternalCodeAgentProbe } from "#src/code-agent/runtime-executable";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";

test("inventory refresh reads the Devin model catalog and display name", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "daemon-devin-catalog-"));
  const log = join(cwd, "rpc.jsonl");
  const probe: ExternalCodeAgentProbe = {
    which: (name) => (name === "devin" ? "/bin/devin" : undefined),
    spawn: () => ({
      stdout: new Blob(["devin 3000.11.228 (053434014dbd)\n"]).stream(),
      exited: Promise.resolve(0),
    }),
  };
  try {
    const inventory = await discoverCodeAgentInventory({
      probe,
      commands: { devin: [process.execPath, anvilRuntimeFixtures.devin] },
      cwd,
      environment: { HOME: "/fixture/home", PATH: "", PI_OFFLINE: "1", DEVIN_FIXTURE_LOG: log },
      piModels: async () => [],
    });
    expect(inventory.runtimes).toContainEqual({
      provider: "devin",
      version: "3000.11.228",
      displayName: "Devin",
    });
    expect(inventory.catalogs.find((catalog) => catalog.provider === "devin")).toEqual({
      provider: "devin",
      models: [
        expect.objectContaining({
          id: "gpt-6-sol-high",
          reasoningEfforts: [],
          defaultReasoning: "",
          recommended: true,
        }),
        expect.objectContaining({ id: "gpt-6-sol-low" }),
        expect.objectContaining({ id: "claude-opus-5-5-medium" }),
      ],
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
