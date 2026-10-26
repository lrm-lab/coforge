import { VERSION_PROBE_TIMEOUT_MS, PROCESS_TREE_EXIT_GRACE_MS } from "@lrm/coforge-anvil";
import { expect, test } from "bun:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { dshCatalogFromConfig } from "#src/dsh/catalog";

const TEST_ACP_TIMEOUT_MS = 10_000;
// Version probe, initialize/new/cancel (catalog: initialize/new/close), then TERM and KILL waits.
const TEST_BUDGET_MS =
  VERSION_PROBE_TIMEOUT_MS + 3 * TEST_ACP_TIMEOUT_MS + 2 * PROCESS_TREE_EXIT_GRACE_MS;

const options: SessionConfigOption[] = [
  {
    id: "model",
    name: "Model",
    type: "select",
    category: "model",
    currentValue: '["deepseek-official","deepseek-v4-pro"]',
    options: [
      {
        group: "deepseek-official",
        name: "DeepSeek",
        options: [
          { value: '["deepseek-official","deepseek-v4-pro"]', name: "DeepSeek V4 Pro" },
          { value: '["deepseek-official","deepseek-v4-flash"]', name: "DeepSeek V4 Flash" },
        ],
      },
    ],
  },
  {
    id: "reasoning_effort",
    name: "Reasoning",
    type: "select",
    currentValue: "high",
    options: ["off", "low", "high", "max"].map((value) => ({ value, name: value })),
  },
];

test("DSH catalogs preserve opaque native model ids and runtime reasoning selections", () => {
  const catalog = dshCatalogFromConfig(options);
  expect(catalog.provider).toBe(RUNTIME_PROVIDER.DSH);
  expect(catalog.models.map((model) => model.id)).toEqual([
    '["deepseek-official","deepseek-v4-pro"]',
    '["deepseek-official","deepseek-v4-flash"]',
  ]);
  expect(catalog.models[0]).toMatchObject({
    displayName: "DeepSeek V4 Pro",
    recommended: true,
    reasoningEfforts: ["off", "low", "high", "max"],
    defaultReasoning: "high",
  });
  expect(catalog.models[1]?.recommended).toBe(false);
});

test("DSH accepts a flat model list without inventing reasoning support", () => {
  const catalog = dshCatalogFromConfig([
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "native-id",
      options: [{ value: "native-id", name: "Native model" }],
    },
  ]);
  expect(catalog.models[0]).toMatchObject({
    id: "native-id",
    reasoningEfforts: [],
    defaultReasoning: "",
  });
});

test("missing or empty DSH model catalogs fail instead of fabricating defaults", () => {
  expect(() => dshCatalogFromConfig([])).toThrow("DSH model catalog is unavailable");
  expect(() =>
    dshCatalogFromConfig([
      { id: "model", name: "Model", type: "select", currentValue: "", options: [] },
    ]),
  ).toThrow("DSH model catalog is unavailable");
});

test(
  "DSH catalog exchange closes its native session and cleans private launch files",
  async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { discoverDshCatalog } = await import("#src/dsh/catalog-discovery");
    const { createDshLaunchContents } = await import("#src/dsh/launch-contents");
    const { fixturePerTurnHost, fixtureVersionReader } = await import("./fixtures/runtime-host");
    const cwd = await mkdtemp(join(tmpdir(), "anvil-dsh-catalog-"));
    const patchPath = join(cwd, "patch.json");
    const pluginPath = join(cwd, "plugin.mjs");
    const log = join(cwd, "rpc.jsonl");
    try {
      const catalog = await discoverDshCatalog({
        timeoutMs: TEST_ACP_TIMEOUT_MS,
        command: [process.execPath, new URL("./fixtures/dsh-acp.ts", import.meta.url).pathname],
        cwd,
        environment: { DSH_FIXTURE_LOG: log },
        host: {
          clientInfo: { name: "dsh-catalog-fixture", version: "1" },
          processTreeSpawner: fixturePerTurnHost.processTreeSpawner,
          versionReader: fixtureVersionReader,
          buildEnvironment: (options) => ({ ...options.environment }),
          createReplyIntentScanner: () => ({
            feed: () => undefined,
            complete: () => {},
            reset: () => [],
          }),
          isShellToolName: () => false,
          prepareLaunch: async (instructions) => {
            const contents = createDshLaunchContents(instructions, pluginPath);
            await writeFile(pluginPath, contents.plugin, { mode: 0o600 });
            await writeFile(patchPath, contents.patch, { mode: 0o600 });
            return {
              patchPath,
              cleanup: async () => {
                await Promise.all([
                  rm(pluginPath, { force: true }),
                  rm(patchPath, { force: true }),
                ]);
              },
            };
          },
        },
      });
      expect(catalog.models.map((model) => model.id)).toEqual(["native-model"]);
      const calls = (await Bun.file(log).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls.map((call) => call.method)).toEqual([
        "initialize",
        "session/new",
        "session/close",
      ]);
      expect(await Bun.file(pluginPath).exists()).toBe(false);
      expect(await Bun.file(patchPath).exists()).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  TEST_BUDGET_MS,
);
