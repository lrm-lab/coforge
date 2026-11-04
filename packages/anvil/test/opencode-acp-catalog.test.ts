import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverOpenCodeAcpCatalog } from "@lrm/coforge-anvil/opencode";
import { fixturePerTurnHost } from "./fixtures/runtime-host";

const FIXTURE = new URL("./fixtures/opencode-acp.ts", import.meta.url).pathname;

function host(environment: Record<string, string> = {}, version = "2.1.0") {
  let spawns = 0;
  const runtimeHost = {
    clientInfo: { name: "oc-acp-fixture", version: "1" },
    processTreeSpawner: {
      spawn: (...args: Parameters<typeof fixturePerTurnHost.processTreeSpawner.spawn>) => {
        spawns++;
        return fixturePerTurnHost.processTreeSpawner.spawn(...args);
      },
    } as never,
    versionReader: async () => version,
    buildEnvironment: () => environment,
    createReplyIntentScanner: () => ({
      feed: () => undefined,
      complete: () => {},
      reset: () => [],
    }),
    isShellToolName: () => false,
  };
  return { runtimeHost, spawns: () => spawns };
}

async function withCwd<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-oc-catalog-"));
  try {
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("the model catalog comes from session/new's model config option", async () => {
  await withCwd(async (cwd) => {
    const { runtimeHost } = host();
    const catalog = await discoverOpenCodeAcpCatalog(
      [process.execPath, FIXTURE],
      cwd,
      {},
      runtimeHost,
      10_000,
    );
    expect(catalog?.provider).toBe("opencode");
    expect(catalog?.models.map((model) => model.id)).toEqual([
      "opencode/model-a",
      "opencode/model-b",
    ]);
    expect(catalog?.models[0]?.displayName).toBe("Model A");
  });
});

test("a session/new without a model option yields no catalog, never a thrown error", async () => {
  await withCwd(async (cwd) => {
    const { runtimeHost } = host();
    const catalog = await discoverOpenCodeAcpCatalog(
      [process.execPath, FIXTURE],
      cwd,
      { OPENCODE_ACP_FIXTURE_CONFIG_OPTIONS: "[]" },
      runtimeHost,
      10_000,
    );
    expect(catalog).toBeUndefined();
  });
});

test("a CLI below the ACP floor is refused before the server spawns", async () => {
  await withCwd(async (cwd) => {
    const { runtimeHost, spawns } = host({}, "1.18.31");
    const catalog = await discoverOpenCodeAcpCatalog(
      [process.execPath, FIXTURE],
      cwd,
      {},
      runtimeHost,
      10_000,
    );
    expect(catalog).toBeUndefined();
    expect(spawns()).toBe(0);
  });
});
