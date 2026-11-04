import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { UpdateAgentInput } from "#src/features/agents/agent.schemas";
import type { RuntimeSelection } from "#src/features/agents/agent-runtime-fields";

/** The slice of an Agent profile the runtime editors read. */
export type RuntimeProfile = {
  id: string;
  displayName: string;
  description?: string | null;
  computerId?: string | null;
  /** `undefined` for an Agent whose stored config the server could not read: its edit input
   * cannot be written back, so `profileUpdateInput` refuses it before touching the fields. */
  runtimeConfig:
    | {
        runtime: RuntimeProvider;
        modelProvider: string;
        model: string;
        reasoning: string;
        fastMode?: boolean;
      }
    | undefined;
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
  // The update rewrites the stored runtimeConfig wholesale, so an Agent whose stored config the
  // server could not read refuses every edit — the bad row needs repair, not more writes.
  if (!profile.runtimeConfig)
    throw new Error("this Agent's stored configuration could not be read");
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
export function profileRuntimeSelection(
  profile: NonNullable<RuntimeProfile["runtimeConfig"]>,
): RuntimeSelection {
  return {
    provider: profile.runtime,
    modelProvider: profile.modelProvider,
    model: profile.model,
    reasoning: profile.reasoning,
    fastMode: profile.fastMode === true,
  };
}

/** The facts the panel's diagnostics copy writes: workspace and Computer context, the runtime
 * line ("unknown" when the stored config could not be read), the stop flag and the status. */
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
