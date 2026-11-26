import {
  RUNTIME_PROVIDER,
  RUNTIME_PROVIDER_VALUES,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import { z } from "zod";
import { modelSizesApply } from "#src/features/agents/agent-model-sizes";
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
  /** What a person filled in on the Agent's form, when they did: it wins over the runtime's own
   * model entry, which fills whatever stays absent (task #30). */
  contextWindow?: number;
  maxOutputTokens?: number;
  environment?: EncryptedAgentEnvironment;
};

export const LEGACY_ANTIGRAVITY_EFFORT_MODELS: Readonly<
  Record<string, { model: string; reasoning: string }>
> = {
  "gemini-3.8-flash-high": { model: "gemini-3.8-flash", reasoning: "high" },
  "gemini-3.8-flash-medium": { model: "gemini-3.8-flash", reasoning: "medium" },
  "gemini-3.8-flash-low": { model: "gemini-3.8-flash", reasoning: "low" },
  "gemini-3.7-flash-high": { model: "gemini-3.7-flash", reasoning: "high" },
  "gemini-3.7-flash-medium": { model: "gemini-3.7-flash", reasoning: "medium" },
  "gemini-3.7-flash-low": { model: "gemini-3.7-flash", reasoning: "low" },
  "gemini-3.6-flash-high": { model: "gemini-3.6-flash", reasoning: "high" },
  "gemini-3.6-flash-medium": { model: "gemini-3.6-flash", reasoning: "medium" },
  "gemini-3.6-flash-low": { model: "gemini-3.6-flash", reasoning: "low" },
  "gemini-3.1-pro-high": { model: "gemini-3.1-pro", reasoning: "high" },
  "gemini-3.1-pro-low": { model: "gemini-3.1-pro", reasoning: "low" },
};

function legacyAntigravitySplit(runtime: RuntimeProvider, model: string) {
  return runtime === RUNTIME_PROVIDER.ANTIGRAVITY &&
    Object.hasOwn(LEGACY_ANTIGRAVITY_EFFORT_MODELS, model)
    ? LEGACY_ANTIGRAVITY_EFFORT_MODELS[model]
    : undefined;
}

/** Refuses a runtime provider an Agent cannot be given (`runtimeProviderSelectionRefusal`). */
export function assertProviderSelectable(provider: unknown) {
  const refusal = runtimeProviderSelectionRefusal(provider);
  if (refusal) throw new AppError("INVALID_INPUT", { errorId: refusal });
}

/** Whether a config's sizes do anything (`modelSizesApply`): Pi on the Computer's own configured
 * providers or on OpenRouter. A built-in provider is stored under its key (`kind: "coforge"`). */
function sizesApply(runtime: RuntimeProvider, provider: AgentRuntimeProviderConfig) {
  return modelSizesApply(runtime, provider.kind === "coforge" ? provider.providerId : "");
}

/** The stored config for what was picked, with the Agent's encrypted environment when it has one. */
export function agentRuntimeConfig(
  selection: {
    provider: RuntimeProvider;
    model: string;
    modelProvider: string;
    reasoning: string;
    fastMode?: boolean;
    contextWindow?: number;
    maxOutputTokens?: number;
  },
  provider: AgentRuntimeProviderConfig,
  environment?: EncryptedAgentEnvironment,
): AgentRuntimeConfig {
  // Sizes for a pick that does not read them are not kept (task #124).
  const sized = sizesApply(selection.provider, provider);
  if (selection.reasoning === "" && legacyAntigravitySplit(selection.provider, selection.model))
    throw new AppError("INVALID_INPUT", { errorId: "antigravity-model-effort-suffix" });
  return {
    runtime: selection.provider,
    provider,
    model: selection.model,
    modelProvider: selection.modelProvider,
    reasoning: selection.reasoning,
    ...(selection.fastMode ? { fastMode: true } : {}),
    ...(!sized || selection.contextWindow === undefined
      ? {}
      : { contextWindow: selection.contextWindow }),
    ...(!sized || selection.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: selection.maxOutputTokens }),
    ...(environment ? { environment } : {}),
  };
}

const positiveIntSchema = z.int().positive();

const encryptedAgentEnvironmentSchema = z.object({
  keyId: z.string(),
  ciphertext: z.string(),
  nonce: z.string(),
});

const encryptedRuntimeApiKeySchema = z.object({
  keyId: z.string(),
  ciphertext: z.string(),
  nonce: z.string(),
  hint: z.string(),
});

const providerConfigSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default") }),
  z.object({
    kind: z.literal("coforge"),
    providerId: z.string().min(1),
    apiKey: encryptedRuntimeApiKeySchema.optional(),
  }),
]);

const storedAgentRuntimeConfigSchema = z.object({
  runtime: z.enum(RUNTIME_PROVIDER_VALUES),
  provider: providerConfigSchema.optional(),
  model: z.string(),
  modelProvider: z.string().optional(),
  reasoning: z.string(),
  fastMode: z.boolean().optional(),
  contextWindow: positiveIntSchema.optional(),
  maxOutputTokens: positiveIntSchema.optional(),
  environment: encryptedAgentEnvironmentSchema.optional(),
});

export function parseAgentRuntimeConfig(value: unknown, agentId?: string): AgentRuntimeConfig {
  const parsed = storedAgentRuntimeConfigSchema.parse(value);
  let provider: AgentRuntimeProviderConfig;
  if (parsed.provider === undefined) {
    console.debug("agent_runtime_provider_default", { agentId, path: "provider" });
    provider = { kind: "default" };
  } else if (parsed.provider.kind === "coforge") {
    provider = {
      kind: "coforge",
      providerId: parsed.provider.providerId,
      ...(parsed.provider.apiKey ? { apiKey: parsed.provider.apiKey } : {}),
    };
  } else {
    provider = parsed.provider;
  }
  const legacy =
    parsed.reasoning === "" ? legacyAntigravitySplit(parsed.runtime, parsed.model) : undefined;
  return {
    runtime: parsed.runtime,
    provider,
    model: legacy?.model ?? parsed.model,
    modelProvider: parsed.modelProvider ?? "",
    reasoning: legacy?.reasoning ?? parsed.reasoning,
    ...(parsed.fastMode === true ? { fastMode: true } : {}),
    ...(parsed.contextWindow === undefined ? {} : { contextWindow: parsed.contextWindow }),
    ...(parsed.maxOutputTokens === undefined ? {} : { maxOutputTokens: parsed.maxOutputTokens }),
    ...(parsed.environment ? { environment: parsed.environment } : {}),
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
    return parseAgentRuntimeConfig(value, agentId);
  } catch (error) {
    console.warn("agent_runtime_config_unreadable", {
      agentId,
      path: unreadableFieldPath(error) || undefined,
    });
    return undefined;
  }
}

/**
 * The runtime fields a Start launches with. `agentConfigRevision` is the Agent's
 * `runtimeConfigRevision`; every Start carries it so the Daemon holds the revision the server last
 * pushed, and it is omitted only while it is 0 (never changed), which the wire cannot carry.
 */
export function runtimeStartFields(config: AgentRuntimeConfig, agentConfigRevision = 0) {
  const launchProviderConfig =
    config.provider.kind === "coforge"
      ? { kind: config.provider.kind, providerId: config.provider.providerId }
      : config.provider;
  // A pair saved before sizes were limited to the picks that read them is left out (task #124).
  const sized = sizesApply(config.runtime, config.provider);
  return {
    provider: config.runtime,
    model: config.model,
    modelProvider: config.modelProvider,
    reasoning: config.reasoning,
    providerConfig: launchProviderConfig,
    // The form's sizes, when a person filled them in; absent leaves the model entry in charge.
    ...(!sized || config.contextWindow === undefined
      ? {}
      : { contextWindow: config.contextWindow }),
    ...(!sized || config.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: config.maxOutputTokens }),
    // Absent means the ordinary tier; never send a `false` the daemon would have to read as one.
    ...(config.fastMode ? { fastMode: true } : {}),
    ...(agentConfigRevision > 0 ? { agentConfigRevision } : {}),
  };
}
