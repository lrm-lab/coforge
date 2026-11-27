import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { UpdateAgentInput } from "#src/features/agents/agent.schemas";
import type { RuntimeSelection } from "#src/features/agents/agent-runtime-fields";

export type RuntimeProviderView =
  | { kind: "default" }
  | { kind: "coforge"; providerId: string }
  | { kind: "codex-compatible"; baseUrl: string; hasKey?: true };

export type RuntimeProfile = {
  id: string;
  displayName: string;
  description?: string | null;
  computerId?: string | null;
  runtimeConfig:
    | {
        runtime: RuntimeProvider;
        modelProvider: string;
        model: string;
        reasoning: string;
        fastMode?: boolean;
        provider?: RuntimeProviderView;
      }
    | undefined;
};

export function profileUpdateInput(
  profile: RuntimeProfile,
  overrides: { displayName?: string; description?: string },
): UpdateAgentInput {
  if (!profile.runtimeConfig)
    throw new Error("this Agent's stored configuration could not be read");
  const provider = profile.runtimeConfig.provider;
  return {
    agentId: profile.id,
    displayName: overrides.displayName ?? profile.displayName,
    description: overrides.description ?? profile.description ?? "",
    provider: profile.runtimeConfig.runtime,
    modelProvider: profile.runtimeConfig.modelProvider || undefined,
    model: profile.runtimeConfig.model,
    reasoning: profile.runtimeConfig.reasoning,
    fastMode: profile.runtimeConfig.fastMode === true,
    ...(provider?.kind === "codex-compatible" ? { baseUrl: provider.baseUrl } : {}),
    ...(profile.computerId ? { computerId: profile.computerId } : {}),
  };
}

export function profileRuntimeSelection(
  profile: NonNullable<RuntimeProfile["runtimeConfig"]>,
): RuntimeSelection {
  return {
    provider: profile.runtime,
    modelProvider: profile.modelProvider,
    model: profile.model,
    reasoning: profile.reasoning,
    fastMode: profile.fastMode === true,
    ...(profile.provider?.kind === "codex-compatible"
      ? {
          baseUrl: profile.provider.baseUrl,
          hasCodexCompatibleKey: Boolean(profile.provider.hasKey),
        }
      : {}),
  };
}

export function agentMigrationRuntime(
  config: RuntimeProfile["runtimeConfig"],
): { runtime: RuntimeProvider; model: string } | undefined {
  return config ? { runtime: config.runtime, model: config.model } : undefined;
}

export function profileDiagnosticFacts(profile: {
  id: string;
  workspaceId: string;
  computerId?: string | null;
  computer?: { computerVersion?: string | null } | null;
  runtimeConfig?: { runtime?: string; model?: string } | undefined;
  stopped: boolean;
  status: { value: string };
}) {
  return {
    id: profile.id,
    workspaceId: profile.workspaceId,
    computerId: profile.computerId ?? null,
    computerVersion: profile.computer?.computerVersion ?? null,
    runtime: profile.runtimeConfig?.runtime ?? "unknown",
    model: profile.runtimeConfig?.model ?? "unknown",
    stopped: profile.stopped,
    status: profile.status.value,
  };
}
