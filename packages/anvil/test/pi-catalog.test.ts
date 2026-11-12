import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { discoverPiCatalog, PI_CATALOG_DISCOVERY_TIMEOUT_MS } from "@lrm/coforge-anvil/pi";

test("Pi's catalog keeps a model's size, and says nothing when Pi reports none", async () => {
  // The Agent form shows these and offers them as the value when the person leaves the fields
  // blank, so a dropped number means the form cannot fill itself in (task #30).
  const catalog = await discoverPiCatalog(
    tmpdir(),
    {},
    { getDefaultAgentDirectory: () => tmpdir() },
    async () =>
      [
        { id: "sized", provider: "openrouter", contextWindow: 200_000, maxTokens: 32_000 },
        { id: "no-window", provider: "openai", maxTokens: 8_192 },
        // A provider reporting nonsense is not a number the form should show.
        { id: "nonsense", provider: "openai", contextWindow: 0, maxTokens: 1.5 },
        { id: "silent", provider: "anthropic" },
      ] as never,
    PI_CATALOG_DISCOVERY_TIMEOUT_MS,
  );
  expect(
    Object.fromEntries(
      (catalog?.models ?? []).map((model) => [
        model.id,
        { contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens },
      ]),
    ),
  ).toEqual({
    sized: { contextWindow: 200_000, maxOutputTokens: 32_000 },
    "no-window": { contextWindow: undefined, maxOutputTokens: 8_192 },
    nonsense: { contextWindow: undefined, maxOutputTokens: undefined },
    silent: { contextWindow: undefined, maxOutputTokens: undefined },
  });
});

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
