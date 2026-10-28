import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverDevinCatalog } from "#src/devin/catalog";
import { fixturePerTurnHost } from "./fixtures/runtime-host";

test("the Devin catalog is session/new's model select", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-devin-catalog-"));
  try {
    const catalog = await discoverDevinCatalog(
      [process.execPath, new URL("./fixtures/devin-acp.ts", import.meta.url).pathname],
      cwd,
      { DEVIN_FIXTURE_LOG: join(cwd, "rpc.jsonl") },
      {
        clientInfo: { name: "devin-fixture", version: "1" },
        processTreeSpawner: fixturePerTurnHost.processTreeSpawner,
        versionReader: async () => "3000.11.228",
        buildEnvironment: () => ({ DEVIN_FIXTURE_LOG: join(cwd, "rpc.jsonl") }),
        buildCatalogEnvironment: () => ({ DEVIN_FIXTURE_LOG: join(cwd, "rpc.jsonl") }),
        createReplyIntentScanner: () => ({
          feed: () => undefined,
          complete: () => {},
          reset: () => [],
        }),
        isShellToolName: () => false,
      },
    );
    expect(catalog?.provider).toBe("devin");
    expect(catalog?.models.map((model) => model.id)).toEqual([
      "gpt-6-sol-high",
      "gpt-6-sol-low",
      "claude-opus-5-5-medium",
    ]);
    expect(catalog?.models[0]).toMatchObject({
      displayName: "GPT-6 Sol High",
      description: "Thinking high",
      recommended: true,
      reasoningEfforts: [],
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
