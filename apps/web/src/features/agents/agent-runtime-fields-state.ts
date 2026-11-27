import {
  RUNTIME_PROVIDER,
  RUNTIME_PROVIDER_SUPPORTS_FAST_MODE,
  type CodeAgentModelMetadata,
  type RuntimeProvider,
  type RuntimeUnavailableCode,
} from "@lrm/coforge-sdk/internal";
import {
  CODEX_COMPATIBLE_MODEL_PROVIDER,
  codexCompatibleBaseUrl,
  selectsCodexCompatible,
} from "@lrm/coforge-sdk/internal/codex-compatible-provider";
import { isPiBuiltinModelProvider } from "./agent.schemas";
import { modelSizesDirty, type ModelSizes } from "./agent-model-sizes";
import { modelProviderDisplayName } from "./model-provider-display";

export type RuntimeCatalog = {
  provider: string;
  models: CodeAgentModelMetadata[];
  observedAt?: string | Date;
};
export type RuntimeOptions = {
  providers: string[];
  unusable: {
    provider: RuntimeProvider;
    unavailableCode: RuntimeUnavailableCode;
    diagnostic?: string | null;
  }[];
  catalogs: RuntimeCatalog[];
  codexCompatible?: boolean;
};

export type RuntimeSelection = {
  provider: RuntimeProvider;
  modelProvider: string;
  model: string;
  reasoning: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  fastMode?: boolean;
  baseUrl?: string;
  hasCodexCompatibleKey?: boolean;
};

export type RuntimeProviderNoticeContext = {
  provider: RuntimeProvider;
  modelProvider: string;
  codexCompatibleSupported: boolean;
  onUseCodexCompatible: () => void;
};

export function reasoningFieldState(
  efforts: readonly string[] | undefined,
  reasoning: string,
): { visible: boolean; submitted: string } {
  if (!efforts) return { visible: false, submitted: reasoning };
  return { visible: efforts.length > 0, submitted: efforts.includes(reasoning) ? reasoning : "" };
}

export function codexCompatibleOrigin(value: string): string | undefined {
  const parsed = codexCompatibleBaseUrl(value);
  return parsed ? new URL(parsed).origin : undefined;
}

export function codexCompatibleCanKeepKey(
  initial: RuntimeSelection | undefined,
  baseUrl: string,
): boolean {
  if (!initial?.hasCodexCompatibleKey) return false;
  if (!selectsCodexCompatible(initial.provider, initial.modelProvider)) return false;
  const previousOrigin = codexCompatibleOrigin(initial.baseUrl ?? "");
  const nextOrigin = codexCompatibleOrigin(baseUrl);
  return Boolean(previousOrigin && nextOrigin && previousOrigin === nextOrigin);
}

export function codexCompatibleOriginChanged(
  initial: RuntimeSelection | undefined,
  baseUrl: string,
): boolean {
  if (!initial?.hasCodexCompatibleKey) return false;
  if (!selectsCodexCompatible(initial.provider, initial.modelProvider)) return false;
  const previousOrigin = codexCompatibleOrigin(initial.baseUrl ?? "");
  const nextOrigin = codexCompatibleOrigin(baseUrl);
  return Boolean(previousOrigin && nextOrigin && previousOrigin !== nextOrigin);
}

export function runtimeRequiresModel(provider: RuntimeProvider, modelProvider?: string): boolean {
  return (
    provider === RUNTIME_PROVIDER.ANTIGRAVITY || selectsCodexCompatible(provider, modelProvider)
  );
}

export function fastModeFieldState(
  provider: RuntimeProvider,
  fastMode: boolean,
): { visible: boolean; submitted: boolean } {
  const visible = RUNTIME_PROVIDER_SUPPORTS_FAST_MODE[provider];
  return { visible, submitted: visible ? fastMode : false };
}

export function isRuntimeDirty(params: {
  manualDirty: boolean;
  apiKey: string;
  provider: RuntimeProvider;
  submittedModelProvider: string;
  modelValue: string;
  submittedReasoning: string;
  submittedFastMode: boolean;
  sizes: ModelSizes;
  sizesApply: boolean;
  baseUrl?: string;
  initial?: RuntimeSelection;
}): boolean {
  return (
    params.manualDirty ||
    (params.sizesApply && modelSizesDirty(params.sizes, params.initial)) ||
    params.apiKey.trim() !== "" ||
    (params.baseUrl?.trim() ?? "") !== (params.initial?.baseUrl ?? "") ||
    params.provider !== (params.initial?.provider ?? RUNTIME_PROVIDER.COFORGE) ||
    params.submittedModelProvider !== (params.initial?.modelProvider ?? "") ||
    params.modelValue !== (params.initial?.model ?? "") ||
    params.submittedReasoning !== (params.initial?.reasoning ?? "") ||
    params.submittedFastMode !== (params.initial?.fastMode ?? false)
  );
}

export function piInitialProviderChoice(
  initial: RuntimeSelection | undefined,
  credentialConfigured: boolean,
): string {
  if (!credentialConfigured || initial?.provider !== RUNTIME_PROVIDER.PI) return "";
  return initial.modelProvider ?? "";
}

export function piExtraProviderOption(
  initial: RuntimeSelection | undefined,
  credentialConfigured: boolean,
): string | undefined {
  const choice = piInitialProviderChoice(initial, credentialConfigured);
  return choice && !isPiBuiltinModelProvider(choice) ? choice : undefined;
}

export function isPiCustomModel(
  models: CodeAgentModelMetadata[],
  modelProvider: string | undefined,
  model: string,
): boolean {
  if (!model) return false;
  return !models.some((item) => item.id === model && item.modelProvider === modelProvider);
}

export function joinCustomModel(modelProvider: string | undefined, model: string): string {
  return `${modelProvider ?? ""}/${model}`;
}

export function splitCustomModel(
  value: string,
): { modelProvider: string; model: string } | undefined {
  const trimmed = value.trim();
  const index = trimmed.indexOf("/");
  if (index <= 0 || index === trimmed.length - 1) return undefined;
  return { modelProvider: trimmed.slice(0, index), model: trimmed.slice(index + 1) };
}

export function piConfiguredModelLabel(model: CodeAgentModelMetadata): string {
  return `${model.displayName} · ${modelProviderDisplayName(model.modelProvider)}`;
}

export function modelOptionValue(model: CodeAgentModelMetadata) {
  return `${encodeURIComponent(model.modelProvider)}--${encodeURIComponent(model.id)}`;
}

export function runtimeModels(options: RuntimeOptions | undefined, provider: RuntimeProvider) {
  return options?.catalogs.find((item) => item.provider === provider)?.models ?? [];
}

export function piConfiguredModels(options: RuntimeOptions | undefined) {
  return runtimeModels(options, RUNTIME_PROVIDER.PI);
}

export function piBuiltinModels(options: RuntimeOptions | undefined, modelProvider: string) {
  return runtimeModels(options, RUNTIME_PROVIDER.COFORGE).filter(
    (model) => model.modelProvider === modelProvider,
  );
}

export function submittedRuntimeModel(params: {
  provider: RuntimeProvider;
  modelProvider: string;
  piBuiltin: boolean;
  piProviderChoice: string;
  customModelActive: boolean;
  customSplit?: { modelProvider: string; model: string };
  selectedModel?: { modelProvider?: string; id: string };
  modelKey: string;
  initialModelKey: string;
  codexModel?: string;
  initial?: RuntimeSelection;
}): { modelProvider: string; model: string } {
  if (selectsCodexCompatible(params.provider, params.modelProvider)) {
    return {
      modelProvider: CODEX_COMPATIBLE_MODEL_PROVIDER,
      model: (params.codexModel ?? "").trim(),
    };
  }
  const sameRuntime = params.provider === params.initial?.provider;
  return {
    modelProvider: params.piBuiltin
      ? params.piProviderChoice
      : params.provider === RUNTIME_PROVIDER.COFORGE
        ? params.modelProvider
        : params.customModelActive
          ? (params.customSplit?.modelProvider ?? "")
          : (params.selectedModel?.modelProvider ??
            (sameRuntime && params.modelKey === params.initialModelKey
              ? (params.initial?.modelProvider ?? "")
              : "")),
    model: params.customModelActive
      ? (params.customSplit?.model ?? "")
      : (params.selectedModel?.id ??
        (sameRuntime && params.modelKey === params.initialModelKey
          ? (params.initial?.model ?? "")
          : "")),
  };
}
