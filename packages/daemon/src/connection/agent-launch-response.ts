import { agentEnvironmentShapeViolation } from "@lrm/coforge-sdk/internal";
import { isAgentApiKey } from "#src/credentials/agent-api-key";
import type { AgentRuntimeProviderConfig } from "@lrm/coforge-anvil";

/** Readers of the fields an Agent launch response carries: each refuses what is not exactly the
 * field's shape. */

export function parseAgentApiKey(value: unknown): string {
  if (typeof value !== "string" || !isAgentApiKey(value))
    throw new Error("invalid Agent API key response");
  return value;
}

/** The Agent's stored environment. Only its shape has to be usable here: a name the rule reserves
 * is kept, because the launch skips it and reports it (`code-agent/environment.ts`) — refusing the
 * map would stop an Agent over a variable the daemon can simply not apply. */
export function parseAgentEnvironment(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    agentEnvironmentShapeViolation(value as Record<string, unknown>)
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
