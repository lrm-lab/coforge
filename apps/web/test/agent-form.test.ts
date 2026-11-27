import { expect, test } from "bun:test";
import { RUNTIME_PROVIDER, RUNTIME_PROVIDER_VALUES } from "@lrm/coforge-sdk/internal";
import { CODEX_COMPATIBLE_MODEL_PROVIDER } from "@lrm/coforge-sdk/internal/codex-compatible-provider";
import { AppError, isAppError } from "#src/lib/app-error";
import {
  agentCreateModelError,
  agentEnvironmentNameError,
  agentUpdateErrorMessage,
  agentEnvironmentRowsChanged,
  parseAgentEnvironmentFromForm,
  updateAgentInputFromForm,
} from "#src/features/agents/agent-form";
import { runtimeRequiresModel } from "#src/features/agents/agent-runtime-fields";
import { m } from "#src/paraglide/messages";

function formWithEnvRows(rows: { key: string; value: string }[]) {
  const form = new FormData();
  for (const row of rows) {
    form.append("envKey", row.key);
    form.append("envValue", row.value);
  }
  return form;
}

test("parseAgentEnvironmentFromForm drops empty keys and keeps the last duplicate", () => {
  const form = formWithEnvRows([
    { key: "FOO", value: "one" },
    { key: "", value: "ignored" },
    { key: "  ", value: "ignored" },
    { key: "FOO", value: "two" },
    { key: "BAR", value: "bar" },
  ]);
  expect(parseAgentEnvironmentFromForm(form)).toEqual({ FOO: "two", BAR: "bar" });
});

test("parseAgentEnvironmentFromForm trims keys but leaves values untouched", () => {
  const form = formWithEnvRows([{ key: "  SPACED  ", value: "  padded  " }]);
  expect(parseAgentEnvironmentFromForm(form)).toEqual({ SPACED: "  padded  " });
});

test("parseAgentEnvironmentFromForm returns an empty map for a form with no env rows", () => {
  expect(parseAgentEnvironmentFromForm(new FormData())).toEqual({});
});

test("agentEnvironmentRowsChanged is order-insensitive and ignores blank-key rows", () => {
  const initial = { A: "1", B: "2" };
  expect(
    agentEnvironmentRowsChanged(
      [
        { key: "B", value: "2" },
        { key: "A", value: "1" },
      ],
      initial,
    ),
  ).toBe(false);
  expect(
    agentEnvironmentRowsChanged(
      [
        { key: "A", value: "1" },
        { key: "B", value: "2" },
        { key: "", value: "should not count" },
      ],
      initial,
    ),
  ).toBe(false);
});

test("agentEnvironmentRowsChanged reports true for an added, removed, or changed row", () => {
  const initial = { A: "1" };
  expect(
    agentEnvironmentRowsChanged(
      [
        { key: "A", value: "1" },
        { key: "B", value: "2" },
      ],
      initial,
    ),
  ).toBe(true);
  expect(agentEnvironmentRowsChanged([], initial)).toBe(true);
  expect(agentEnvironmentRowsChanged([{ key: "A", value: "different" }], initial)).toBe(true);
});

test("agentEnvironmentNameError flags a name the server would refuse, before Save sends it", () => {
  const invalidName = m.agent_env_invalid_name({ max: 128 });
  expect(agentEnvironmentNameError("11")).toBe(invalidName);
  expect(agentEnvironmentNameError("BAD-NAME")).toBe(invalidName);
  expect(agentEnvironmentNameError("A".repeat(129))).toBe(invalidName);
  expect(agentEnvironmentNameError("path")).toBe(m.agent_env_reserved_name());
  expect(agentEnvironmentNameError("COFORGE_TOKEN")).toBe(m.agent_env_reserved_name());
  expect(agentEnvironmentNameError(" MY_VAR ")).toBeUndefined();
  expect(agentEnvironmentNameError("_x1")).toBeUndefined();
  expect(agentEnvironmentNameError("  ")).toBeUndefined();
});

test("a refused environment save shows the broken rule instead of asking to try again", () => {
  const refusal = (errorId: string) =>
    agentUpdateErrorMessage(new AppError("INVALID_INPUT", { errorId }));
  expect(refusal("agent-environment-invalid-name")).toBe(m.agent_env_invalid_name({ max: 128 }));
  expect(refusal("agent-environment-reserved-name")).toBe(m.agent_env_reserved_name());
  expect(refusal("agent-environment-invalid-value")).toBe(m.agent_env_invalid_value());
  expect(refusal("agent-environment-too-many")).toBe(m.agent_env_too_many({ max: 64 }));
  expect(refusal("agent-environment-too-large")).toBe(m.agent_env_too_large());
});

test("a refused Agent save names the reason instead of only asking to try again", () => {
  const refusal = (
    errorId: string,
    code: "INVALID_INPUT" | "ACCESS_DENIED" | "INTERNAL_ERROR" | "CONFLICT" = "INVALID_INPUT",
  ) => agentUpdateErrorMessage(new AppError(code, { errorId }));
  expect(refusal("agent-name-required")).toBe(m.agent_form_name_required());
  expect(refusal("agent-provider-unsupported")).toBe(m.agent_form_provider_unsupported());
  expect(refusal("agent-computer-required")).toBe(m.agent_form_computer_required());
  expect(refusal("agent-computer-locked")).toBe(m.agent_form_computer_locked());
  expect(refusal("agent-not-authorized", "ACCESS_DENIED")).toBe(m.agent_form_not_authorized());
  expect(refusal("agent-model-provider-required")).toBe(m.agent_form_model_provider_required());
  expect(refusal("agent-credential-unavailable", "INTERNAL_ERROR")).toBe(
    m.agent_form_credential_unavailable(),
  );
  expect(refusal("agent-api-key-required")).toBe(m.agent_form_api_key_required());
  expect(refusal("agent-runtime-unavailable")).toBe(m.agent_form_runtime_unavailable());
  expect(refusal("agent-name-taken")).toBe(m.agent_form_name_taken());
  expect(refusal("agent-migrating", "CONFLICT")).toBe(m.agent_form_migrating());
  expect(agentUpdateErrorMessage(new Error("provider is not supported"))).toBe(
    m.agent_update_error(),
  );
  expect(refusal("an-error-id-nobody-mapped")).toBe(m.agent_update_error());
});

test("a runtime save refused as not_connected names it", () => {
  const error = new AppError("INVALID_INPUT", {
    errorId: "agent-runtime-unavailable",
    details: { reason: "not_connected" },
  });
  expect(agentUpdateErrorMessage(error)).toMatch(/not connected|未连接/i);
});
test("a runtime save refused with an unknown reason falls back to the generic", () => {
  const error = new AppError("INVALID_INPUT", {
    errorId: "agent-runtime-unavailable",
    details: { reason: "something-else" },
  });
  expect(agentUpdateErrorMessage(error).length).toBeGreaterThan(0);
});

test("AppError details round-trip through the wire message", () => {
  const thrown = new AppError("INVALID_INPUT", {
    errorId: "agent-runtime-unavailable",
    details: { reason: "not_connected" },
  });
  const wire = Object.assign(new Error(thrown.message), {
    name: "AppError",
    code: "INVALID_INPUT",
  });
  expect(isAppError(wire)).toBe(true);
  expect((wire as unknown as AppError).details).toEqual({ reason: "not_connected" });
  expect(agentUpdateErrorMessage(wire)).toMatch(/not connected|未连接/i);
});

test("runtimeRequiresModel is true only for Antigravity", () => {
  expect(runtimeRequiresModel(RUNTIME_PROVIDER.ANTIGRAVITY)).toBe(true);
  for (const provider of RUNTIME_PROVIDER_VALUES) {
    if (provider === RUNTIME_PROVIDER.ANTIGRAVITY) continue;
    expect(runtimeRequiresModel(provider)).toBe(false);
  }
});

test("agentCreateModelError blocks empty Antigravity model and leaves other runtimes unchanged", () => {
  expect(agentCreateModelError(RUNTIME_PROVIDER.ANTIGRAVITY, "")).toBe(
    m.agent_form_model_required(),
  );
  expect(agentCreateModelError(RUNTIME_PROVIDER.ANTIGRAVITY, "   ")).toBe(
    m.agent_form_model_required(),
  );
  expect(
    agentCreateModelError(RUNTIME_PROVIDER.ANTIGRAVITY, "gemini-3.1-pro-high"),
  ).toBeUndefined();
  expect(agentCreateModelError(RUNTIME_PROVIDER.ANTIGRAVITY, " gemini-3-flash ")).toBeUndefined();
  for (const provider of RUNTIME_PROVIDER_VALUES) {
    if (provider === RUNTIME_PROVIDER.ANTIGRAVITY) continue;
    expect(agentCreateModelError(provider, "")).toBeUndefined();
    expect(agentCreateModelError(provider, "   ")).toBeUndefined();
  }
});

test("codex-compatible requires a model and maps endpoint/key errors and baseUrl form values", () => {
  expect(runtimeRequiresModel(RUNTIME_PROVIDER.CODEX, CODEX_COMPATIBLE_MODEL_PROVIDER)).toBe(true);
  expect(agentCreateModelError(RUNTIME_PROVIDER.CODEX, "", CODEX_COMPATIBLE_MODEL_PROVIDER)).toBe(
    m.agent_form_model_required(),
  );
  expect(
    agentCreateModelError(RUNTIME_PROVIDER.CODEX, "gpt-5.4", CODEX_COMPATIBLE_MODEL_PROVIDER),
  ).toBeUndefined();

  expect(
    agentUpdateErrorMessage(
      new AppError("INVALID_INPUT", { errorId: "agent-codex-compatible-endpoint-required" }),
    ),
  ).toBe(m.agent_form_codex_compatible_endpoint_required());
  expect(
    agentUpdateErrorMessage(
      new AppError("INVALID_INPUT", { errorId: "agent-codex-compatible-key-required" }),
    ),
  ).toBe(m.agent_form_codex_compatible_key_required());

  const withBaseUrl = new FormData();
  withBaseUrl.set("provider", RUNTIME_PROVIDER.CODEX);
  withBaseUrl.set("modelProvider", CODEX_COMPATIBLE_MODEL_PROVIDER);
  withBaseUrl.set("model", "gpt-5.4");
  withBaseUrl.set("baseUrl", "  https://relay.example.com/v1 ");
  expect(updateAgentInputFromForm(withBaseUrl, { agentId: "a1", computerId: "c1" })).toMatchObject({
    agentId: "a1",
    computerId: "c1",
    provider: RUNTIME_PROVIDER.CODEX,
    modelProvider: CODEX_COMPATIBLE_MODEL_PROVIDER,
    model: "gpt-5.4",
    baseUrl: "https://relay.example.com/v1",
  });
});
