import { expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { CODEX_COMPATIBLE_MODEL_PROVIDER } from "@lrm/coforge-sdk/internal/codex-compatible-provider";

import {
  agentMigrationRuntime,
  profileRuntimeSelection,
  profileUpdateInput,
} from "#src/features/agents/profile-panel/agent-profile-runtime";
import { readableRuntimeConfig } from "#src/server/agents/agent-runtime-config.server";

const readable = {
  runtime: RUNTIME_PROVIDER.PI,
  modelProvider: "",
  model: "pi-default",
  reasoning: "",
};

test("a readable runtime config names the migration refusal's runtime and model", () => {
  expect(agentMigrationRuntime(readable)).toEqual({
    runtime: RUNTIME_PROVIDER.PI,
    model: "pi-default",
  });
});

test("an unreadable stored config leaves the migration section nothing to name", () => {
  const stored = { runtime: 42, provider: "not-an-object" };
  expect(agentMigrationRuntime(readableRuntimeConfig(stored, "agent-1"))).toBeUndefined();
});

test("profileRuntimeSelection and profileUpdateInput preserve codex-compatible baseUrl and key flag", () => {
  const runtimeConfig = {
    runtime: RUNTIME_PROVIDER.CODEX,
    modelProvider: CODEX_COMPATIBLE_MODEL_PROVIDER,
    model: "gpt-5.4",
    reasoning: "medium",
    fastMode: true,
    provider: {
      kind: "codex-compatible" as const,
      baseUrl: "https://relay.example.com/v1",
      hasKey: true as const,
    },
  };
  expect(profileRuntimeSelection(runtimeConfig)).toEqual({
    provider: RUNTIME_PROVIDER.CODEX,
    modelProvider: CODEX_COMPATIBLE_MODEL_PROVIDER,
    model: "gpt-5.4",
    reasoning: "medium",
    fastMode: true,
    baseUrl: "https://relay.example.com/v1",
    hasCodexCompatibleKey: true,
  });
  expect(
    profileUpdateInput(
      {
        id: "agent-codex",
        displayName: "Codex Relay",
        description: "desc",
        computerId: "comp-1",
        runtimeConfig,
      },
      { displayName: "Renamed" },
    ),
  ).toEqual({
    agentId: "agent-codex",
    displayName: "Renamed",
    description: "desc",
    provider: RUNTIME_PROVIDER.CODEX,
    modelProvider: CODEX_COMPATIBLE_MODEL_PROVIDER,
    model: "gpt-5.4",
    reasoning: "medium",
    fastMode: true,
    baseUrl: "https://relay.example.com/v1",
    computerId: "comp-1",
  });
});
