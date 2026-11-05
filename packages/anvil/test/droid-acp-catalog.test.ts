import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverDroidAcpCatalog } from "#src/droid/acp-catalog";
import { fixturePerTurnHost } from "./fixtures/runtime-host";

const host = {
  clientInfo: { name: "droid-catalog-fixture", version: "1" },
  processTreeSpawner: fixturePerTurnHost.processTreeSpawner,
  versionReader: async () => "1.4.1",
  createReplyIntentScanner: () => ({ feed: () => undefined, complete: () => {}, reset: () => [] }),
  isShellToolName: () => false,
  buildEnvironment: () => ({}),
};

test("the catalog is session/new's model select, with each model's reasoning_effort read in the same session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-droid-catalog-"));
  try {
    const catalog = await discoverDroidAcpCatalog(
      [process.execPath, new URL("./fixtures/droid-acp.ts", import.meta.url).pathname],
      cwd,
      { DROID_ACP_FIXTURE_LOG: join(cwd, "rpc.jsonl") },
      host as never,
      10_000,
    );
    expect(catalog?.provider).toBe("droid");
    expect(catalog?.models.map((model) => model.id)).toEqual([
      "auto",
      "claude-sonnet-5",
      "gpt-6.1-sol",
    ]);
    // The fixture publishes low/high/max after any model applies, and defaults to high.
    for (const model of catalog!.models) {
      expect(model.reasoningEfforts).toEqual(["low", "high", "max"]);
      expect(model.defaultReasoning).toBe("high");
    }
    expect(catalog?.models.find((model) => model.recommended)?.id).toBe("gpt-6.1-sol");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a droid below the ACP floor returns no catalog and spawns nothing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-droid-catalog-"));
  const log = join(cwd, "rpc.jsonl");
  try {
    const catalog = await discoverDroidAcpCatalog(
      [process.execPath, new URL("./fixtures/droid-acp.ts", import.meta.url).pathname],
      cwd,
      { DROID_ACP_FIXTURE_LOG: log },
      { ...host, versionReader: async () => "1.3.0" } as never,
      10_000,
    );
    expect(catalog).toBeUndefined();
    expect(await Bun.file(log).exists()).toBe(false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
