import { codexCompatibleEnvironment } from "@lrm/coforge-sdk/internal/codex-compatible-provider";
import { agentEnvironmentShapeViolation } from "@lrm/coforge-sdk/internal";
import { z } from "zod";
import { isAgentApiKey } from "#src/credentials/agent-api-key";
import type { AgentRuntimeProviderConfig } from "@lrm/coforge-anvil";
import type { AgentLaunchConfig } from "./daemon-connection-client";
import { parseAgentLaunchIdentity } from "./agent-launch-identity";

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

const runtimeProviderConfigSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("default") }),
  z.strictObject({
    kind: z.literal("coforge"),
    providerId: z.string(),
    apiKey: z.string().optional(),
  }),
]);

export function parseAgentRuntimeProviderConfig(
  value: unknown,
): AgentRuntimeProviderConfig | undefined {
  if (value === undefined) return undefined;
  const parsed = runtimeProviderConfigSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid Agent runtime provider config response");
  if (parsed.data.kind === "default") return { kind: "default" };
  return {
    kind: "coforge",
    providerId: parsed.data.providerId,
    ...(parsed.data.apiKey !== undefined ? { apiKey: parsed.data.apiKey } : {}),
  };
}

/** The whole Agent launch response: the Agent's key, and its provider, environment, assigned
 * skill packs and identity where the server sent them. */
export function parseAgentLaunchConfig(response: unknown): AgentLaunchConfig {
  const value = response as {
    apiKey?: unknown;
    providerConfig?: unknown;
    envVars?: unknown;
    codexCompatibleEnvironment?: unknown;
    runtimeConfigRevision?: unknown;
    assignedSkillPacks?: unknown;
    identity?: unknown;
  };
  const providerConfig = parseAgentRuntimeProviderConfig(value.providerConfig);
  const compatible = codexCompatibleEnvironment(value.codexCompatibleEnvironment);
  if (value.codexCompatibleEnvironment !== undefined && !compatible)
    throw new Error("invalid Codex compatible provider environment");
  const assignedSkillPacks = Array.isArray(value.assignedSkillPacks)
    ? value.assignedSkillPacks.filter((entry): entry is string => typeof entry === "string")
    : [];
  const identity = parseAgentLaunchIdentity(value.identity);
  const { runtimeConfigRevision } = value;
  return {
    agentApiKey: parseAgentApiKey(value.apiKey),
    ...(providerConfig ? { providerConfig } : {}),
    envVars: parseAgentEnvironment(value.envVars),
    ...(compatible ? { codexCompatibleEnvironment: compatible } : {}),
    ...(typeof runtimeConfigRevision === "number" &&
      Number.isInteger(runtimeConfigRevision) &&
      runtimeConfigRevision >= 0 &&
      runtimeConfigRevision <= 2 ** 32 - 1 && { runtimeConfigRevision }),
    ...(assignedSkillPacks.length > 0 ? { assignedSkillPacks } : {}),
    ...(identity ? { identity } : {}),
  };
}
