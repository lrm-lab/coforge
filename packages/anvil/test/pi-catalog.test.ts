import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { discoverPiCatalog, PI_CATALOG_DISCOVERY_TIMEOUT_MS } from "@lrm/coforge-anvil/pi";

test("Pi reasoning levels are the ones the SDK supports for each model", async () => {
  // Pi's thinkingLevelMap marks an unsupported level `null` and leaves a supported one out;
  // `xhigh` and `max` exist only when mapped. A model without reasoning offers no levels.
  const catalog = await discoverPiCatalog(
    tmpdir(),
    {},
    { getDefaultAgentDirectory: () => tmpdir() },
    async () =>
      [
        { id: "no-off", provider: "openrouter", reasoning: true, thinkingLevelMap: { off: null } },
        {
          id: "with-max",
          provider: "anthropic",
          reasoning: true,
          thinkingLevelMap: { max: "max" },
        },
        { id: "plain", provider: "openai", reasoning: true },
        { id: "chat", provider: "openai", reasoning: false },
      ] as never,
    PI_CATALOG_DISCOVERY_TIMEOUT_MS,
  );
  expect(
    Object.fromEntries((catalog?.models ?? []).map((model) => [model.id, model.reasoningEfforts])),
  ).toEqual({
    "no-off": ["minimal", "low", "medium", "high"],
    "with-max": ["off", "minimal", "low", "medium", "high", "max"],
    plain: ["off", "minimal", "low", "medium", "high"],
    chat: [],
  });
});
