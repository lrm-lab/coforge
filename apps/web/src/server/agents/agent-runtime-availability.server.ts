import { RUNTIME_PROVIDER, type RuntimeProvider } from "@lrm/coforge-sdk/internal";

export type AgentRuntimeSelection = {
  provider: RuntimeProvider;
  model: string;
  modelProvider: string;
  reasoning: string;
  hasApiKey: boolean;
};

export function agentRuntimeSelectionIsAvailable(
  config: AgentRuntimeSelection,
  inventory: {
    connected: boolean;
    providers: ReadonlySet<RuntimeProvider>;
    models: readonly unknown[];
  },
): boolean {
  if (!inventory.connected) return false;
  if (!providerIsSelectable(config.provider, inventory.providers)) return false;
  // CoForge/keyed Pi may authorize a provider before the catalog model is chosen.
  if (
    config.modelProvider &&
    (config.provider === RUNTIME_PROVIDER.COFORGE ||
      (config.provider === RUNTIME_PROVIDER.PI && config.hasApiKey))
  )
    return true;
  if (!config.model) return !config.modelProvider && !config.reasoning;
  return inventory.models.some((value) => modelMatches(value, config));
}

/** Why a Computer cannot run an Agent with this selection, told apart as the reference Computer
 * tells its refusals apart: not in the Workspace; no runtime reported yet; this runtime not among
 * those reported; reported but not shared with this person; or offered without the model. */
export type AgentRuntimeSelectionRefusal =
  | "not_connected"
  | "runtime_unconfirmed"
  | "runtime_missing"
  | "runtime_not_shared"
  | "model_missing";

/**
 * Why `agentRuntimeSelectionIsAvailable` refuses this selection, or null when it does not.
 * `reported` is every runtime the Computer reported, shared or not; `providers` only those this
 * person may select there.
 */
export function agentRuntimeSelectionRefusal(
  config: AgentRuntimeSelection,
  inventory: Parameters<typeof agentRuntimeSelectionIsAvailable>[1] & {
    reported: ReadonlySet<RuntimeProvider>;
  },
): AgentRuntimeSelectionRefusal | null {
  if (!inventory.connected) return "not_connected";
  if (agentRuntimeSelectionIsAvailable(config, inventory)) return null;
  if (inventory.reported.size === 0) return "runtime_unconfirmed";
  if (!providerIsSelectable(config.provider, inventory.reported)) return "runtime_missing";
  if (!providerIsSelectable(config.provider, inventory.providers)) return "runtime_not_shared";
  return "model_missing";
}

function providerIsSelectable(
  provider: RuntimeProvider,
  providers: ReadonlySet<RuntimeProvider>,
): boolean {
  if (providers.has(provider)) return true;
  return provider === RUNTIME_PROVIDER.COFORGE && providers.has(RUNTIME_PROVIDER.PI);
}

function modelMatches(value: unknown, config: AgentRuntimeSelection): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const id = Reflect.get(value, "id");
  const modelProvider = Reflect.get(value, "modelProvider");
  const efforts = Reflect.get(value, "reasoningEfforts");
  return (
    id === config.model &&
    modelProvider === config.modelProvider &&
    (!config.reasoning || (Array.isArray(efforts) && efforts.includes(config.reasoning)))
  );
}
