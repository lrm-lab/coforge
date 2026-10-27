import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCodeAgentInventory } from "#src/code-agent/runtime-inventory";
import type { ExternalCodeAgentProbe } from "#src/code-agent/runtime-executable";
import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";

test("inventory refresh reads the Command Code model catalog", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "daemon-command-code-catalog-"));
  const log = join(cwd, "rpc.jsonl");
  const probe: ExternalCodeAgentProbe = {
    which: (name) => (name === "cmd" ? "/bin/cmd" : undefined),
    spawn: () => ({
      stdout: new Blob(["1.88.0\n"]).stream(),
      exited: Promise.resolve(0),
    }),
  };
  try {
    const inventory = await discoverCodeAgentInventory({
      probe,
      commands: {
        commandCode: [process.execPath, anvilRuntimeFixtures.commandCode],
      },
      cwd,
      environment: {
        HOME: "/fixture/home",
        PATH: "",
        PI_OFFLINE: "1",
        COMMAND_CODE_FIXTURE_LOG: log,
      },
      piModels: async () => [],
    });
    expect(inventory.runtimes).toContainEqual({
      provider: "command-code",
      version: "1.88.0",
      displayName: "Command Code",
    });
    expect(inventory.catalogs.find((catalog) => catalog.provider === "command-code")).toEqual({
      provider: "command-code",
      models: [
        expect.objectContaining({
          id: "native-model",
          reasoningEfforts: [],
          defaultReasoning: "",
          recommended: true,
        }),
        expect.objectContaining({ id: "other-model", reasoningEfforts: [] }),
        expect.objectContaining({ id: "plain-model", reasoningEfforts: [] }),
      ],
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
