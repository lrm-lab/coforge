import { expect, test } from "bun:test";
import { discoverGrokCatalog, GROK_CATALOG_TIMEOUT_MS } from "#src/code-agent/grok/catalog";
import { PROCESS_TREE_EXIT_GRACE_MS } from "#src/code-agent/process-tree-cleanup";

test(
  "discovers the native per-model reasoning choices without creating a session",
  async () => {
    const fixture = new URL("./fixtures/grok-catalog-fixture.ts", import.meta.url).pathname;
    const catalog = await discoverGrokCatalog([process.execPath, fixture], process.cwd(), Bun.env);
    expect(catalog).toEqual({
      provider: "grok",
      models: [
        {
          id: "grok-4.7",
          displayName: "Grok 4.7",
          description: "SpaceXAI's latest frontier model",
          modelProvider: "",
          reasoningEfforts: ["xhigh", "high", "medium", "low"],
          defaultReasoning: "high",
          recommended: true,
        },
        expect.objectContaining({
          id: "grok-4.7-build-fast",
          reasoningEfforts: ["xhigh", "high", "medium", "low"],
          defaultReasoning: "high",
          recommended: false,
        }),
        expect.objectContaining({
          id: "grok-4.6",
          reasoningEfforts: ["xhigh", "high", "medium", "low"],
          defaultReasoning: "high",
        }),
        expect.objectContaining({
          id: "grok-4.5",
          reasoningEfforts: ["high", "medium", "low"],
          defaultReasoning: "high",
        }),
      ],
    });
  },
  GROK_CATALOG_TIMEOUT_MS + 2 * PROCESS_TREE_EXIT_GRACE_MS,
);
