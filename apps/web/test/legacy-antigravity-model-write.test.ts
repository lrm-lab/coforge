import { expect, test } from "bun:test";

import {
  agentRuntimeConfig,
  parseAgentRuntimeConfig,
} from "#src/server/agents/agent-runtime-config.server";
import { agentControlRevision } from "#src/server/agents/agent-control-types.server";
import { AppError } from "#src/lib/app-error";

function selection(model: string, reasoning = "") {
  return { provider: "antigravity" as const, model, modelProvider: "", reasoning };
}

test("writing a legacy suffixed id is refused", () => {
  const error = (() => {
    try {
      agentRuntimeConfig(selection("gemini-3.8-flash-medium"), { kind: "default" });
      return undefined;
    } catch (caught) {
      return caught;
    }
  })();
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).errorId).toBe("antigravity-model-effort-suffix");
});

test("writing a real catalog model with a suffix is accepted", () => {
  expect(agentRuntimeConfig(selection("gpt-oss-120b-medium"), { kind: "default" })).toMatchObject({
    model: "gpt-oss-120b-medium",
    reasoning: "",
  });
});

test("reading a legacy row twice yields one config revision, and the rebuilt form matches it", () => {
  const stored = {
    runtime: "antigravity",
    provider: { kind: "default" },
    model: "gemini-3.6-flash-high",
    modelProvider: "",
    reasoning: "",
  };
  const first = agentControlRevision(parseAgentRuntimeConfig(stored));
  const second = agentControlRevision(parseAgentRuntimeConfig(stored));
  const rebuilt = agentControlRevision(
    agentRuntimeConfig(selection("gemini-3.6-flash", "high"), { kind: "default" }),
  );
  expect(first).toBe(second);
  expect(rebuilt).toBe(first);
});
