import { externalCredentialRateLimitMessage } from "./external-agent-credential-error";
import {
  AGENT_ENVIRONMENT_MAX_NAME_LENGTH,
  AGENT_ENVIRONMENT_MAX_VARIABLES,
  agentEnvironmentNameViolation,
  type AgentEnvironmentViolation,
  parseRuntimeProvider,
  RUNTIME_PROVIDER,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";

import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import type { UpdateAgentInput } from "./agent.schemas";
import { submittedModelSize } from "./agent-model-sizes";
import { runtimeRequiresModel } from "./agent-runtime-fields-state";

export function agentCreateModelError(
  provider: RuntimeProvider,
  model: string,
): string | undefined {
  return runtimeRequiresModel(provider) && model.trim() === ""
    ? m.agent_form_model_required()
    : undefined;
}

export function updateAgentInputFromForm(
  form: FormData,
  fallback: { agentId: string; computerId?: string; displayName?: string; description?: string },
): UpdateAgentInput {
  const computerId = String(form.get("computerId") ?? fallback.computerId ?? "").trim();
  const apiKey = String(form.get("apiKey") ?? "").trim();
  const displayName = String(form.get("displayName") ?? fallback.displayName ?? "").trim();
  const description = form.has("description")
    ? String(form.get("description") ?? "")
    : (fallback.description ?? "");
  return {
    agentId: fallback.agentId,
    description,
    provider: parseRuntimeProvider(form.get("provider")) ?? RUNTIME_PROVIDER.COFORGE,
    modelProvider: String(form.get("modelProvider") ?? ""),
    model: String(form.get("model") ?? ""),
    reasoning: String(form.get("reasoning") ?? ""),
    fastMode: form.get("fastMode") === "true",
    ...sizesFromForm(form),
    ...(apiKey ? { apiKey } : {}),
    ...(displayName ? { displayName } : {}),
    ...(computerId ? { computerId } : {}),
  };
}

export function sizesFromForm(form: FormData) {
  const contextWindow = submittedModelSize(String(form.get("contextWindow") ?? ""));
  const maxOutputTokens = submittedModelSize(String(form.get("maxOutputTokens") ?? ""));
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

const AGENT_ENVIRONMENT_ERROR_MESSAGES: Record<AgentEnvironmentViolation, () => string> = {
  "too-many": () => m.agent_env_too_many({ max: AGENT_ENVIRONMENT_MAX_VARIABLES }),
  "invalid-name": () => m.agent_env_invalid_name({ max: AGENT_ENVIRONMENT_MAX_NAME_LENGTH }),
  "reserved-name": m.agent_env_reserved_name,
  "invalid-value": m.agent_env_invalid_value,
  "too-large": m.agent_env_too_large,
};

const AGENT_RUNTIME_UNAVAILABLE_REASONS = new Map<string, () => string>([
  ["not_connected", m.agent_form_runtime_unavailable_not_connected],
  ["runtime_unconfirmed", m.agent_form_runtime_unavailable_unconfirmed],
  ["runtime_missing", m.agent_form_runtime_unavailable_missing],
  ["runtime_unusable", m.agent_form_runtime_unavailable_unusable],
  ["runtime_not_shared", m.agent_form_runtime_unavailable_not_shared],
  ["model_missing", m.agent_form_runtime_unavailable_model_missing],
  ["fast_mode_unsupported", m.agent_form_runtime_unavailable_fast_mode],
]);

const AGENT_FORM_ERROR_MESSAGES = new Map<string, () => string>([
  ["agent-api-key-required", m.agent_form_api_key_required],
  ["agent-migrating", m.agent_form_migrating],
  ["agent-computer-required", m.agent_form_computer_required],
  ["agent-computer-locked", m.agent_form_computer_locked],
  ["agent-name-taken", m.agent_form_name_taken],
  ["agent-name-required", m.agent_form_name_required],
  ["agent-provider-unsupported", m.agent_form_provider_unsupported],
  ["agent-not-authorized", m.agent_form_not_authorized],
  ["agent-model-provider-required", m.agent_form_model_provider_required],
  ["antigravity-model-effort-suffix", m.agent_form_model_effort_suffix],
  ["agent-credential-unavailable", m.agent_form_credential_unavailable],
  ...Object.entries(AGENT_ENVIRONMENT_ERROR_MESSAGES).map(
    ([violation, message]) => [`agent-environment-${violation}`, message] as const,
  ),
]);

function agentFormErrorMessage(cause: unknown, fallback: () => string): string {
  if (isAppError(cause)) {
    if (cause.errorId === "agent-runtime-unavailable") {
      const reason = (cause.details as { reason?: string } | undefined)?.reason;
      return (
        AGENT_RUNTIME_UNAVAILABLE_REASONS.get(reason ?? "") ?? m.agent_form_runtime_unavailable
      )();
    }
    const message = AGENT_FORM_ERROR_MESSAGES.get(cause.errorId ?? "");
    if (message) return message();
  }
  return fallback();
}

export function agentUpdateErrorMessage(cause: unknown): string {
  return agentFormErrorMessage(cause, m.agent_update_error);
}

export function agentCreateErrorMessage(cause: unknown): string {
  return (
    externalCredentialRateLimitMessage(cause) ??
    agentFormErrorMessage(cause, m.agent_form_server_error)
  );
}

export function agentEnvironmentNameError(key: string): string | undefined {
  const name = key.trim();
  const violation = name ? agentEnvironmentNameViolation(name) : undefined;
  return violation && AGENT_ENVIRONMENT_ERROR_MESSAGES[violation]();
}

export function parseAgentEnvironmentFromForm(form: FormData): Record<string, string> {
  const keys = form.getAll("envKey").map(String);
  const values = form.getAll("envValue").map(String);
  const result: Record<string, string> = {};
  keys.forEach((key, index) => {
    const trimmed = key.trim();
    if (!trimmed) return;
    result[trimmed] = values[index] ?? "";
  });
  return result;
}

export function agentEnvironmentRowsChanged(
  rows: { key: string; value: string }[],
  initial: Record<string, string>,
): boolean {
  const next: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    next[key] = row.value;
  }
  const nextKeys = Object.keys(next);
  const initialKeys = Object.keys(initial);
  if (nextKeys.length !== initialKeys.length) return true;
  return nextKeys.some((key) => next[key] !== initial[key]);
}
