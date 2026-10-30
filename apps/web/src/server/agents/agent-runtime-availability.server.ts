import {
  RUNTIME_PROVIDER,
  RUNTIME_PROVIDER_SUPPORTS_FAST_MODE,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";

export type AgentRuntimeSelection = {
  provider: RuntimeProvider;
  model: string;
  modelProvider: string;
  reasoning: string;
  hasApiKey: boolean;
  /** Whether this selection asks for the runtime's Fast service tier. Absent means it does not. */
  fastMode?: boolean;
};

/** Whether the selection can run there. `requireModel: false` asks only whether the runtime can
 * take this Agent at all: a model catalog is an observation, not a permission (a move checks it
 * when the Agent starts there). */
export type AgentRuntimeAvailability = {
  connected: boolean;
  providers: ReadonlySet<RuntimeProvider>;
  models: readonly unknown[];
};

export function agentRuntimeSelectionIsAvailable(
  config: AgentRuntimeSelection,
  inventory: AgentRuntimeAvailability,
  options: { requireModel?: boolean } = {},
): boolean {
  if (!inventory.connected) return false;
  if (!providerIsSelectable(config.provider, inventory.providers)) return false;
  if (fastModeUnsupported(config)) return false;
  // CoForge/keyed Pi may authorize a provider before the catalog model is chosen.
  if (
    config.modelProvider &&
    (config.provider === RUNTIME_PROVIDER.COFORGE ||
      (config.provider === RUNTIME_PROVIDER.PI && config.hasApiKey))
  )
    return true;
  if (!config.model) return !config.modelProvider && !config.reasoning;
  if (options.requireModel === false) return true;
  return inventory.models.some((value) => modelMatches(value, config));
}

/** Why a Computer cannot run an Agent with this selection, told apart as the reference Computer
 * tells its refusals apart: not in the Workspace; no runtime reported yet; this runtime not among
 * those reported; reported but not shared with this person; a Fast request on a runtime that
 * cannot apply it; or offered without the model. */
export type AgentRuntimeSelectionRefusal =
  | "not_connected"
  | "runtime_unconfirmed"
  | "runtime_missing"
  | "runtime_unusable"
  | "runtime_not_shared"
  | "model_missing"
  | "fast_mode_unsupported";

/**
 * Why `agentRuntimeSelectionIsAvailable` refuses this selection, or null when it does not.
 * `reported` is every runtime the Computer reported, shared or not; `unusable` those it reported
 * as installed but not usable; `providers` only those this person may select there.
 */
export type AgentRuntimeRefusalWithoutModel = Exclude<
  AgentRuntimeSelectionRefusal,
  "model_missing"
>;

/** A check that does not read the model catalog cannot refuse for a missing model: saying so in
 * the type keeps the catalog out of callers that only ask "can this runtime take the Agent?". */
export function agentRuntimeSelectionRefusal(
  config: AgentRuntimeSelection,
  inventory: AgentRuntimeAvailability & {
    reported: ReadonlySet<RuntimeProvider>;
    unusable: ReadonlySet<RuntimeProvider>;
  },
  options: { requireModel: false },
): AgentRuntimeRefusalWithoutModel | null;
export function agentRuntimeSelectionRefusal(
  config: AgentRuntimeSelection,
  inventory: AgentRuntimeAvailability & {
    reported: ReadonlySet<RuntimeProvider>;
    unusable: ReadonlySet<RuntimeProvider>;
  },
  options?: { requireModel?: true },
): AgentRuntimeSelectionRefusal | null;
export function agentRuntimeSelectionRefusal(
  config: AgentRuntimeSelection,
  inventory: AgentRuntimeAvailability & {
    reported: ReadonlySet<RuntimeProvider>;
    unusable: ReadonlySet<RuntimeProvider>;
  },
  options: { requireModel?: boolean } = {},
): AgentRuntimeSelectionRefusal | null {
  if (!inventory.connected) return "not_connected";
  if (agentRuntimeSelectionIsAvailable(config, inventory, options)) return null;
  if (inventory.reported.size === 0) return "runtime_unconfirmed";
  if (!providerIsSelectable(config.provider, inventory.reported)) return "runtime_missing";
  if (providerIsSelectable(config.provider, inventory.unusable)) return "runtime_unusable";
  if (!providerIsSelectable(config.provider, inventory.providers)) return "runtime_not_shared";
  // Provider and sharing are settled; a Fast request this runtime cannot apply, or the model.
  // Every check that does not need the model runs first: a move that does not read catalogs must
  // not let a stale one hide a refusal that the target Computer's own page would report.
  if (fastModeUnsupported(config)) return "fast_mode_unsupported";
  return options.requireModel === false ? null : "model_missing";
}

/** Fast mode exists only where the runtime's adapter applies it, and there for every model: one
 * that does not accept it is reported after launch, not refused here. */
function fastModeUnsupported(config: AgentRuntimeSelection): boolean {
  return config.fastMode === true && !RUNTIME_PROVIDER_SUPPORTS_FAST_MODE[config.provider];
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
    (!config.reasoning ||
      // Command Code reports a model's efforts only after a session switches to it
      // (`readCommandCodeReasoningEfforts`), and Devin's ACP model list carries no efforts
      // (its effort select follows the selected model), so their catalogs cannot list them.
      config.provider === RUNTIME_PROVIDER.COMMAND_CODE ||
      config.provider === RUNTIME_PROVIDER.DEVIN ||
      (Array.isArray(efforts) && efforts.includes(config.reasoning)))
  );
}
