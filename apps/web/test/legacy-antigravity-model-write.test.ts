import { expect, test } from "bun:test";

import {
  agentRuntimeConfig,
  LEGACY_ANTIGRAVITY_EFFORT_MODELS,
  parseAgentRuntimeConfig,
} from "#src/server/agents/agent-runtime-config.server";
import { agentControlRevision } from "#src/server/agents/agent-control-types.server";
import { AppError } from "#src/lib/app-error";

function selection(model: string, reasoning = "") {
  return { provider: "antigravity" as const, model, modelProvider: "", reasoning };
}

for (const legacy of Object.keys(LEGACY_ANTIGRAVITY_EFFORT_MODELS)) {
  test(`writing ${legacy} is refused`, () => {
    const error = (() => {
      try {
        agentRuntimeConfig(selection(legacy), { kind: "default" });
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).errorId).toBe("antigravity-model-effort-suffix");
  });
}

test("writing a real catalog model with a suffix is accepted", () => {
  expect(agentRuntimeConfig(selection("gpt-oss-120b-medium"), { kind: "default" })).toMatchObject({
    model: "gpt-oss-120b-medium",
    reasoning: "",
  });
});

test("writing a model named like an Object prototype key is accepted", () => {
  for (const model of ["toString", "constructor", "valueOf", "__proto__"])
    expect(agentRuntimeConfig(selection(model), { kind: "default" })).toMatchObject({ model });
});

test("the config a legacy row reads hashes like the form rebuilt from it, so an unchanged save is not a change", () => {
  const stored = {
    ...agentRuntimeConfig(
      { provider: "antigravity", model: "gemini-3.6-flash", modelProvider: "", reasoning: "" },
      { kind: "default" },
    ),
    model: "gemini-3.6-flash-high",
  };
  expect(agentControlRevision(parseAgentRuntimeConfig(stored))).toBe(
    agentControlRevision(
      agentRuntimeConfig(selection("gemini-3.6-flash", "high"), { kind: "default" }),
    ),
  );
});
