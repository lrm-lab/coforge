import { expect, test } from "bun:test";

import { agentModelName } from "#src/features/agents/agent-model-name";

const catalogs = [
  {
    provider: "dsh",
    models: [{ id: '["route","pro"]', displayName: "DeepSeek-V4-Pro", modelProvider: "" }],
  },
  {
    provider: "pi",
    models: [
      { id: "sonnet", displayName: "Sonnet (Anthropic)", modelProvider: "anthropic" },
      { id: "sonnet", displayName: "Sonnet (OpenRouter)", modelProvider: "openrouter" },
    ],
  },
];

test("a model the runtime's catalog lists goes by the catalog's name", () => {
  expect(agentModelName(catalogs, { runtime: "dsh", model: '["route","pro"]' })).toBe(
    "DeepSeek-V4-Pro",
  );
});

test("the model provider picks between entries that share an id", () => {
  expect(
    agentModelName(catalogs, { runtime: "pi", model: "sonnet", modelProvider: "openrouter" }),
  ).toBe("Sonnet (OpenRouter)");
});

test("the entry for the Agent's own model provider wins over one that names none", () => {
  const shared = [
    {
      provider: "pi",
      models: [
        { id: "sonnet", displayName: "Sonnet", modelProvider: "" },
        { id: "sonnet", displayName: "Sonnet (OpenRouter)", modelProvider: "openrouter" },
      ],
    },
  ];
  expect(
    agentModelName(shared, { runtime: "pi", model: "sonnet", modelProvider: "openrouter" }),
  ).toBe("Sonnet (OpenRouter)");
  expect(agentModelName(shared, { runtime: "pi", model: "sonnet", modelProvider: "x" })).toBe(
    "Sonnet",
  );
});

test("an unlisted model, another runtime's catalog or no catalog leaves the id", () => {
  expect(agentModelName(catalogs, { runtime: "dsh", model: "gone" })).toBe("gone");
  expect(agentModelName(catalogs, { runtime: "codex", model: '["route","pro"]' })).toBe(
    '["route","pro"]',
  );
  expect(agentModelName(undefined, { runtime: "dsh", model: "x" })).toBe("x");
});
