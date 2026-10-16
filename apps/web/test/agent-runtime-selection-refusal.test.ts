import { expect, test } from "bun:test";
import { RUNTIME_PROVIDER, type RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { agentRuntimeSelectionRefusal } from "#src/server/agents/agent-runtime-availability.server";

const claude = {
  provider: RUNTIME_PROVIDER.CLAUDE_CODE,
  model: "sonnet",
  modelProvider: "anthropic",
  reasoning: "",
  hasApiKey: false,
};
const sonnet = { id: "sonnet", modelProvider: "anthropic", reasoningEfforts: [] };

function inventory(
  options: {
    connected?: boolean;
    reported?: RuntimeProvider[];
    selectable?: RuntimeProvider[];
    models?: unknown[];
  } = {},
) {
  return {
    connected: options.connected ?? true,
    reported: new Set(options.reported ?? [RUNTIME_PROVIDER.CLAUDE_CODE]),
    providers: new Set(options.selectable ?? options.reported ?? [RUNTIME_PROVIDER.CLAUDE_CODE]),
    models: options.models ?? [sonnet],
  };
}

test("a Computer that offers the runtime and model to this person can run the Agent", () => {
  expect(agentRuntimeSelectionRefusal(claude, inventory())).toBeNull();
});

test("each reason a Computer cannot run the Agent is told apart, as the reference does", () => {
  // Not part of the Workspace at all.
  expect(agentRuntimeSelectionRefusal(claude, inventory({ connected: false }))).toBe(
    "not_connected",
  );
  // It has not reported any runtime yet, so whether it has this one is unknown.
  expect(agentRuntimeSelectionRefusal(claude, inventory({ reported: [] }))).toBe(
    "runtime_unconfirmed",
  );
  // It reported its runtimes, and this one is not among them.
  expect(
    agentRuntimeSelectionRefusal(claude, inventory({ reported: [RUNTIME_PROVIDER.CODEX] })),
  ).toBe("runtime_missing");
  // It has the runtime, but its owner has not shared it with this person.
  expect(
    agentRuntimeSelectionRefusal(
      claude,
      inventory({ reported: [RUNTIME_PROVIDER.CLAUDE_CODE], selectable: [] }),
    ),
  ).toBe("runtime_not_shared");
  // The runtime is there and usable, but not the Agent's model.
  expect(agentRuntimeSelectionRefusal(claude, inventory({ models: [] }))).toBe("model_missing");
});

test("the built-in runtime counts Pi on the Computer as offering it", () => {
  const builtIn = { ...claude, provider: RUNTIME_PROVIDER.COFORGE, model: "", modelProvider: "" };
  expect(
    agentRuntimeSelectionRefusal(builtIn, inventory({ reported: [RUNTIME_PROVIDER.PI] })),
  ).toBeNull();
  expect(
    agentRuntimeSelectionRefusal(
      builtIn,
      inventory({ reported: [RUNTIME_PROVIDER.PI], selectable: [] }),
    ),
  ).toBe("runtime_not_shared");
});
