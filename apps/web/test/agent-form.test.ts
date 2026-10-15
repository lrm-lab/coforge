import { expect, test } from "bun:test";
import { AppError } from "#src/lib/app-error";
import {
  agentEnvironmentNameError,
  agentUpdateErrorMessage,
  agentEnvironmentRowsChanged,
  parseAgentEnvironmentFromForm,
} from "#src/features/agents/agent-form";
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
  // A blank row is dropped on save (`parseAgentEnvironmentFromForm`), so it is not an error.
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
  // The server's save path has no other wording for these: each throw carries its own id, so the
  // dialog can say which rule refused instead of the generic retry line.
  expect(refusal("agent-name-required")).toBe(m.agent_form_name_required());
  expect(refusal("agent-provider-unsupported")).toBe(m.agent_form_provider_unsupported());
  expect(refusal("agent-computer-required")).toBe(m.agent_form_computer_required());
  expect(refusal("agent-not-authorized", "ACCESS_DENIED")).toBe(m.agent_form_not_authorized());
  expect(refusal("agent-model-provider-required")).toBe(m.agent_form_model_provider_required());
  expect(refusal("agent-credential-unavailable", "INTERNAL_ERROR")).toBe(
    m.agent_form_credential_unavailable(),
  );
  expect(refusal("agent-api-key-required")).toBe(m.agent_form_api_key_required());
  expect(refusal("agent-runtime-unavailable")).toBe(m.agent_form_runtime_unavailable());
  expect(refusal("agent-name-taken")).toBe(m.agent_form_name_taken());
  expect(refusal("agent-migrating", "CONFLICT")).toBe(m.agent_form_migrating());
  // Anything unmapped still asks to retry: a plain Error, or a 5xx during a deploy, carries no
  // rule to name - and "try again" is the honest copy for a request that never reached the rule.
  expect(agentUpdateErrorMessage(new Error("provider is not supported"))).toBe(
    m.agent_update_error(),
  );
  expect(refusal("an-error-id-nobody-mapped")).toBe(m.agent_update_error());
});
