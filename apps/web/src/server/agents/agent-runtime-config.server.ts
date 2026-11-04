import { parseRuntimeProvider, type RuntimeProvider } from "@lrm/coforge-sdk/internal";
import { runtimeProviderSelectionRefusal } from "#src/features/agents/runtime-provider-selection";
import { AppError } from "#src/lib/app-error";

export type EncryptedRuntimeApiKey = {
  keyId: string;
  ciphertext: string;
  nonce: string;
  hint: string;
};

export type EncryptedAgentEnvironment = {
  keyId: string;
  ciphertext: string;
  nonce: string;
};

export type AgentRuntimeProviderConfig =
  | { kind: "default" }
  | {
      kind: "coforge";
      providerId: string;
      apiKey?: EncryptedRuntimeApiKey;
    };

export type AgentRuntimeConfig = {
  runtime: RuntimeProvider;
  provider: AgentRuntimeProviderConfig;
  model: string;
  modelProvider: string;
  reasoning: string;
  /** Whether this Agent launches with the runtime's Fast service tier. Absent (every row written
   * before Fast mode existed) means it does not. */
  fastMode?: boolean;
  environment?: EncryptedAgentEnvironment;
};

/** Refuses a runtime provider an Agent cannot be given (`runtimeProviderSelectionRefusal`). */
export function assertProviderSelectable(provider: unknown) {
  const refusal = runtimeProviderSelectionRefusal(provider);
  if (refusal) throw new AppError("INVALID_INPUT", { errorId: refusal });
}

/** The stored config for what was picked, with the Agent's encrypted environment when it has one. */
export function agentRuntimeConfig(
  selection: {
    provider: RuntimeProvider;
    model: string;
    modelProvider: string;
    reasoning: string;
    fastMode?: boolean;
  },
  provider: AgentRuntimeProviderConfig,
  environment?: EncryptedAgentEnvironment,
): AgentRuntimeConfig {
  return {
    runtime: selection.provider,
    provider,
    model: selection.model,
    modelProvider: selection.modelProvider,
    reasoning: selection.reasoning,
    ...(selection.fastMode ? { fastMode: true } : {}),
    ...(environment ? { environment } : {}),
  };
}

export function parseAgentRuntimeConfig(value: unknown): AgentRuntimeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid runtime config");
  const runtime = parseRuntimeProvider(Reflect.get(value, "runtime"));
  const model = Reflect.get(value, "model");
  const modelProvider = Reflect.get(value, "modelProvider");
  const reasoning = Reflect.get(value, "reasoning");
  const fastMode = Reflect.get(value, "fastMode");
  const environment = parseEncryptedEnvironment(Reflect.get(value, "environment"));
  if (
    !runtime ||
    typeof model !== "string" ||
    (modelProvider !== undefined && typeof modelProvider !== "string") ||
    typeof reasoning !== "string" ||
    (fastMode !== undefined && typeof fastMode !== "boolean")
  )
    throw new Error("invalid runtime config");
  return {
    runtime,
    provider: parseProviderConfig(Reflect.get(value, "provider")),
    model,
    modelProvider: modelProvider ?? "",
    reasoning,
    ...(fastMode === true ? { fastMode: true } : {}),
    ...(environment ? { environment } : {}),
  };
}

export function publicAgentRuntimeConfig(
  config: AgentRuntimeConfig | undefined,
): AgentRuntimeConfig | undefined {
  if (!config) return undefined;
  const { environment: _environment, ...publicConfig } = config;
  return {
    ...publicConfig,
    provider:
      config.provider.kind === "coforge"
        ? {
            kind: config.provider.kind,
            providerId: config.provider.providerId,
          }
        : config.provider,
  };
}

function parseEncryptedEnvironment(value: unknown): EncryptedAgentEnvironment | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid encrypted Agent environment");
  const keyId = Reflect.get(value, "keyId");
  const ciphertext = Reflect.get(value, "ciphertext");
  const nonce = Reflect.get(value, "nonce");
  if (typeof keyId !== "string" || typeof ciphertext !== "string" || typeof nonce !== "string")
    throw new Error("invalid encrypted Agent environment");
  return { keyId, ciphertext, nonce };
}

function parseProviderConfig(value: unknown): AgentRuntimeProviderConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid runtime provider config");
  const kind = Reflect.get(value, "kind");
  if (kind === "default") return { kind };
  const providerId = Reflect.get(value, "providerId");
  if (kind !== "coforge" || typeof providerId !== "string" || !providerId)
    throw new Error("invalid runtime provider config");
  const apiKey = parseEncryptedApiKey(Reflect.get(value, "apiKey"));
  return { kind, providerId, ...(apiKey ? { apiKey } : {}) };
}

function parseEncryptedApiKey(value: unknown): EncryptedRuntimeApiKey | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid encrypted runtime API key");
  const keyId = Reflect.get(value, "keyId");
  const ciphertext = Reflect.get(value, "ciphertext");
  const nonce = Reflect.get(value, "nonce");
  const hint = Reflect.get(value, "hint");
  if (
    typeof keyId !== "string" ||
    typeof ciphertext !== "string" ||
    typeof nonce !== "string" ||
    typeof hint !== "string"
  )
    throw new Error("invalid encrypted runtime API key");
  return { keyId, ciphertext, nonce, hint };
}

/** A stored Agent's runtime config where the caller cannot proceed without one — a write or
 * compare path. A row whose stored config cannot be read refuses with `CONFLICT` (a read path
 * omits it instead; see `AgentRecord`). */
export function requiredRuntimeConfig(agent: { runtimeConfig: AgentRuntimeConfig | undefined }) {
  if (!agent.runtimeConfig)
    throw new AppError("CONFLICT", { errorId: "agent-runtime-config-unreadable" });
  return agent.runtimeConfig;
}

/** The field paths a failed runtime-config parse reports: names only, never the values a
 * Zod issue carries — a config may hold credentials. */
function unreadableFieldPath(error: unknown): string {
  const issues = (error as { issues?: { path?: (string | number)[] }[] }).issues;
  return (issues ?? [])
    .map((issue) => (issue.path ?? []).join("."))
    .filter(Boolean)
    .join(",");
}

/** A stored runtime config a read path may show: the parsed config, or `undefined` when the row
 * cannot be read — one bad Agent loses its runtime fields and logs a warning, never the read. */
export function readableRuntimeConfig(
  value: unknown,
  agentId?: string,
): AgentRuntimeConfig | undefined {
  try {
    return parseAgentRuntimeConfig(value);
  } catch (error) {
    console.warn("agent_runtime_config_unreadable", {
      agentId,
      path: unreadableFieldPath(error) || undefined,
    });
    return undefined;
  }
}
