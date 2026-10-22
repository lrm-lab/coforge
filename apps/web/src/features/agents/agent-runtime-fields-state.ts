import {
  RUNTIME_PROVIDER,
  RUNTIME_PROVIDER_SUPPORTS_FAST_MODE,
  type CodeAgentModelMetadata,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import { isPiBuiltinModelProvider } from "./agent.schemas";
import { modelProviderDisplayName } from "./model-provider-display";

export type RuntimeCatalog = {
  provider: string;
  models: CodeAgentModelMetadata[];
  /** When the Daemon reported this cached catalog. */
  observedAt?: string | Date;
};
export type RuntimeOptions = {
  providers: string[];
  catalogs: RuntimeCatalog[];
};

export type RuntimeSelection = {
  provider: RuntimeProvider;
  modelProvider: string;
  model: string;
  reasoning: string;
  /** Whether the Agent launches with the runtime's Fast service tier. Absent means it does not. */
  fastMode?: boolean;
};

/**
 * Whether the Reasoning field renders and which value the form submits for it. The field shows
 * only when the selected model is in the loaded catalog and reports at least one reasoning level.
 * A catalog model with no levels submits "" so a saved level it cannot accept is cleared. While the
 * model is not in the catalog (loading, load failed, configured model missing) the saved value is
 * submitted unchanged.
 */
export function reasoningFieldState(
  selectedModel: CodeAgentModelMetadata | undefined,
  reasoning: string,
): { visible: boolean; submitted: string } {
  if (!selectedModel) return { visible: false, submitted: reasoning };
  const visible = selectedModel.reasoningEfforts.length > 0;
  return { visible, submitted: visible ? reasoning : "" };
}

/**
 * Whether the Fast mode choice renders and what the form submits for it. As in the reference, the
 * runtime alone decides: the ones whose adapters apply a service tier (Claude Code, Codex) offer it
 * for every model, including the runtime's default, and any other runtime clears the request. A
 * model that turns out not to accept it is reported after launch, not refused here.
 */
export function fastModeFieldState(
  provider: RuntimeProvider,
  fastMode: boolean,
): { visible: boolean; submitted: boolean } {
  const visible = RUNTIME_PROVIDER_SUPPORTS_FAST_MODE[provider];
  return { visible, submitted: visible ? fastMode : false };
}

/**
 * Whether the current field values would actually change something a Save submits — the same
 * comparison for every RuntimeProvider (Pi's Configured/built-in split only changes how
 * `submittedModelProvider`/`modelValue` are derived upstream, not this comparison itself).
 */
export function isRuntimeDirty(params: {
  manualDirty: boolean;
  apiKey: string;
  provider: RuntimeProvider;
  submittedModelProvider: string;
  modelValue: string;
  submittedReasoning: string;
  submittedFastMode: boolean;
  initial?: RuntimeSelection;
}): boolean {
  return (
    params.manualDirty ||
    params.apiKey.trim() !== "" ||
    params.provider !== (params.initial?.provider ?? RUNTIME_PROVIDER.COFORGE) ||
    params.submittedModelProvider !== (params.initial?.modelProvider ?? "") ||
    params.modelValue !== (params.initial?.model ?? "") ||
    params.submittedReasoning !== (params.initial?.reasoning ?? "") ||
    params.submittedFastMode !== (params.initial?.fastMode ?? false)
  );
}

/**
 * The Pi "Provider" choice (`""` for Configured, else a built-in slug) a saved Agent's runtime
 * config opens with. A stored credential (`credentialConfigured`) means the saved config used a
 * keyed built-in provider — DeepSeek, OpenRouter, or one CoForge no longer offers by default
 * (e.g. `zai`, see `piExtraProviderOption`). No stored credential means Configured: the
 * Computer's own Pi setup, whatever raw provider slug it launched Pi with.
 */
export function piInitialProviderChoice(
  initial: RuntimeSelection | undefined,
  credentialConfigured: boolean,
): string {
  if (!credentialConfigured || initial?.provider !== RUNTIME_PROVIDER.PI) return "";
  return initial.modelProvider ?? "";
}

/**
 * A saved Pi built-in provider outside `PI_BUILTIN_MODEL_PROVIDERS` (e.g. `zai`, offered before
 * CoForge narrowed the Pi picker to DeepSeek/OpenRouter): still listed as a Provider option so
 * opening and saving the runtime dialog doesn't silently switch the Agent away from it.
 */
export function piExtraProviderOption(
  initial: RuntimeSelection | undefined,
  credentialConfigured: boolean,
): string | undefined {
  const choice = piInitialProviderChoice(initial, credentialConfigured);
  return choice && !isPiBuiltinModelProvider(choice) ? choice : undefined;
}

/** Whether a saved Pi Configured pick (`modelProvider`/`model`) is absent from the Computer's own
 * Pi catalog — it opens the Model field as Custom, prefilled, rather than falling back to
 * "Configured default" and silently changing the Agent's launch config. */
export function isPiCustomModel(
  models: CodeAgentModelMetadata[],
  modelProvider: string | undefined,
  model: string,
): boolean {
  if (!model) return false;
  return !models.some((item) => item.id === model && item.modelProvider === modelProvider);
}

/** The Custom model ID field's prefill for a saved provider/model pair. */
export function joinCustomModel(modelProvider: string | undefined, model: string): string {
  return `${modelProvider ?? ""}/${model}`;
}

/**
 * Splits a "Custom model ID" entry at the FIRST `/` into `modelProvider`/`model` — a model id can
 * itself contain slashes (an OpenRouter id like `anthropic/claude-x`), so only the first one
 * marks the provider boundary. Returns undefined when the text has no `/`, or either side of it
 * is empty.
 */
export function splitCustomModel(
  value: string,
): { modelProvider: string; model: string } | undefined {
  const trimmed = value.trim();
  const index = trimmed.indexOf("/");
  if (index <= 0 || index === trimmed.length - 1) return undefined;
  return { modelProvider: trimmed.slice(0, index), model: trimmed.slice(index + 1) };
}

/** A Pi Configured model's Select label: the catalog only lists this Computer's Pi models across
 * every host-configured provider, so each option names both. */
export function piConfiguredModelLabel(model: CodeAgentModelMetadata): string {
  return `${model.displayName} · ${modelProviderDisplayName(model.modelProvider)}`;
}

export function modelOptionValue(model: CodeAgentModelMetadata) {
  // Used as both a React `key` and a Select.Item `id`. The official Select
  // (react-aria-components) uses the raw id in an internal CSS selector for
  // its collection, so it must stay free of CSS-selector special characters
  // (JSON.stringify's brackets/quotes/commas broke that). Only ever compared
  // for equality here, never parsed back apart, so any collision-free,
  // selector-safe encoding works.
  return `${encodeURIComponent(model.modelProvider)}--${encodeURIComponent(model.id)}`;
}

export function runtimeModels(options: RuntimeOptions | undefined, provider: RuntimeProvider) {
  return options?.catalogs.find((item) => item.provider === provider)?.models ?? [];
}

/** The models offered by the Pi "Configured" list: exactly the Computer's own Pi catalog
 * (`~/.pi/agent`), never CoForge's keyed-provider catalog — unlike `piBuiltinModels`, which reads
 * that catalog instead once a built-in provider is chosen. */
export function piConfiguredModels(options: RuntimeOptions | undefined) {
  return runtimeModels(options, RUNTIME_PROVIDER.PI);
}

/** The models offered once a Pi built-in provider is selected: CoForge's keyed-provider catalog
 * (the same one the CoForge runtime picker uses), filtered to that one provider. */
export function piBuiltinModels(options: RuntimeOptions | undefined, modelProvider: string) {
  return runtimeModels(options, RUNTIME_PROVIDER.COFORGE).filter(
    (model) => model.modelProvider === modelProvider,
  );
}
