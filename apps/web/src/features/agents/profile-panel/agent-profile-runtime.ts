import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { UpdateAgentInput } from "#src/features/agents/agent.schemas";
import type { RuntimeSelection } from "#src/features/agents/agent-runtime-fields";

/** The slice of an Agent profile the runtime editors read. */
export type RuntimeProfile = {
  id: string;
  displayName: string;
  description?: string | null;
  computerId?: string | null;
  runtimeConfig: {
    runtime: RuntimeProvider;
    modelProvider: string;
    model: string;
    reasoning: string;
    fastMode?: boolean;
  };
};

/**
 * The full update input for an edit that changes only the profile's name or description: the
 * runtime fields are carried over unchanged, so such a save can never clear them (including Fast
 * mode, which the update payload replaces wholesale).
 */
export function profileUpdateInput(
  profile: RuntimeProfile,
  overrides: { displayName?: string; description?: string },
): UpdateAgentInput {
  return {
    agentId: profile.id,
    displayName: overrides.displayName ?? profile.displayName,
    description: overrides.description ?? profile.description ?? "",
    provider: profile.runtimeConfig.runtime,
    modelProvider: profile.runtimeConfig.modelProvider || undefined,
    model: profile.runtimeConfig.model,
    reasoning: profile.runtimeConfig.reasoning,
    fastMode: profile.runtimeConfig.fastMode === true,
    ...(profile.computerId ? { computerId: profile.computerId } : {}),
  };
}

/** The Agent's stored runtime configuration, as the runtime-config dialog opens it. */
export function profileRuntimeSelection(profile: RuntimeProfile): RuntimeSelection {
  return {
    provider: profile.runtimeConfig.runtime,
    modelProvider: profile.runtimeConfig.modelProvider,
    model: profile.runtimeConfig.model,
    reasoning: profile.runtimeConfig.reasoning,
    fastMode: profile.runtimeConfig.fastMode === true,
  };
}
