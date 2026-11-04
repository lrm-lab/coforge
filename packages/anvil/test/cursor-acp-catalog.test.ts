import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCursorAcpCatalog } from "@lrm/coforge-anvil/cursor";
import { fixturePerTurnHost } from "./fixtures/runtime-host";

const FIXTURE = new URL("./fixtures/cursor-acp.ts", import.meta.url).pathname;

function host(environment: Record<string, string> = {}, version = "2026.10.22") {
  const spawns: string[][] = [];
  const runtimeHost = {
    clientInfo: { name: "cursor-acp-fixture", version: "1" },
    processTreeSpawner: {
      spawn: (...args: Parameters<typeof fixturePerTurnHost.processTreeSpawner.spawn>) => {
        spawns.push([String(args[0])]);
        return fixturePerTurnHost.processTreeSpawner.spawn(...args);
      },
    } as typeof fixturePerTurnHost.processTreeSpawner,
    versionReader: async () => version,
    buildEnvironment: () => environment,
    createReplyIntentScanner: () => ({
      feed: () => undefined,
      complete: () => {},
      reset: () => [],
    }),
    isShellToolName: () => false,
  };
  return { runtimeHost, spawns };
}

test("the model catalog comes from session/new's models block, grouped by base name", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-cursor-catalog-"));
  const environment = { CURSOR_ACP_FIXTURE_LOG: join(cwd, "rpc.jsonl") };
  const { runtimeHost, spawns } = host(environment);
  try {
    const catalog = await discoverCursorAcpCatalog(
      [process.execPath, FIXTURE],
      cwd,
      environment,
      runtimeHost,
    );
    expect(catalog?.provider).toBe("cursor");
    expect(
      catalog?.models.map((model) => ({
        id: model.id,
        efforts: model.reasoningEfforts,
        defaultReasoning: model.defaultReasoning,
        recommended: model.recommended,
      })),
    ).toEqual([
      { id: "default", efforts: [], defaultReasoning: "", recommended: true },
      {
        id: "claude-sonnet-5",
        efforts: ["high", "medium"],
        defaultReasoning: "high",
        recommended: false,
      },
      { id: "gpt-5.5", efforts: ["medium"], defaultReasoning: "medium", recommended: false },
    ]);
    expect(spawns).toHaveLength(1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a session/new without a models block yields no catalog, never a thrown error", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-cursor-catalog-"));
  const environment = {
    CURSOR_ACP_FIXTURE_NO_MODELS: "1",
    CURSOR_ACP_FIXTURE_LOG: join(cwd, "rpc.jsonl"),
  };
  const { runtimeHost } = host(environment);
  try {
    const catalog = await discoverCursorAcpCatalog(
      [process.execPath, FIXTURE],
      cwd,
      environment,
      runtimeHost,
    );
    expect(catalog).toBeUndefined();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a CLI below the ACP floor is refused before the server spawns", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-cursor-catalog-"));
  const { runtimeHost, spawns } = host({}, "2025.01.01");
  try {
    const catalog = await discoverCursorAcpCatalog(["/usr/bin/cursor-agent"], cwd, {}, runtimeHost);
    expect(catalog).toBeUndefined();
    expect(spawns).toHaveLength(0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
