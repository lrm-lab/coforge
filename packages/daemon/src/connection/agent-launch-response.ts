import { agentEnvironmentViolation } from "@lrm/coforge-sdk/internal";
import { isAgentApiKey } from "#src/credentials/agent-api-key";
import type { AgentRuntimeProviderConfig } from "#src/code-agent/contract";

/** Readers of the fields an Agent launch response carries: each refuses what is not exactly the
 * field's shape. */

export function parseAgentApiKey(value: unknown): string {
  if (typeof value !== "string" || !isAgentApiKey(value))
    throw new Error("invalid Agent API key response");
  return value;
}

export function parseAgentEnvironment(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    agentEnvironmentViolation(value as Record<string, unknown>)
  )
    throw new Error("invalid Agent environment response");
  const envVars: Record<string, string> = Object.create(null);
  for (const [name, entry] of Object.entries(value)) envVars[name] = entry as string;
  return envVars;
}

export function parseAgentRuntimeProviderConfig(
  value: unknown,
): AgentRuntimeProviderConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object")
    throw new Error("invalid Agent runtime provider config response");
  const config = value as Record<string, unknown>;
  if (config.kind === "default" && Object.keys(config).length === 1) return { kind: "default" };
  if (
    config.kind === "coforge" &&
    typeof config.providerId === "string" &&
    (config.apiKey === undefined || typeof config.apiKey === "string") &&
    Object.keys(config).every((key) => key === "kind" || key === "providerId" || key === "apiKey")
  )
    return {
      kind: "coforge",
      providerId: config.providerId,
      ...(typeof config.apiKey === "string" ? { apiKey: config.apiKey } : {}),
    };
  throw new Error("invalid Agent runtime provider config response");
}
