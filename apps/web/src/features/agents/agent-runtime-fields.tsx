import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  parseRuntimeProvider,
  RUNTIME_PROVIDER,
  RUNTIME_PROVIDER_USES_EXTERNAL_CLI,
} from "@lrm/coforge-sdk/internal";
import {
  CODEX_COMPATIBLE_MODEL_PROVIDER,
  selectsCodexCompatible,
} from "@lrm/coforge-sdk/internal/codex-compatible-provider";

import { useDialogControlSize } from "#src/components/ui/dialog-actions";
import { useCodexCompatibleSupport } from "#src/features/computers/use-codex-compatible-support";
import { m } from "#src/paraglide/messages";
import { AgentCodexCompatibleFields } from "./agent-codex-compatible-fields";
import {
  AgentRuntimeApiKeyField,
  AgentRuntimeCustomModelField,
  AgentRuntimeModelProviderField,
  RuntimeCatalogLoadFailure,
} from "./agent-runtime-fallback-fields";
import { AgentFastModeField } from "./agent-fast-mode-field";
import { AgentModelSizeFields } from "./agent-model-size-fields";
import { initialModelSizes, modelSizesApply } from "./agent-model-sizes";
import { AgentReasoningField } from "./agent-reasoning-field";
import { KEYED_MODEL_PROVIDERS } from "./agent.schemas";
import type { ModelChoice } from "./model-search";
import {
  fastModeFieldState,
  isPiCustomModel,
  isRuntimeDirty,
  joinCustomModel,
  modelOptionValue,
  piBuiltinModels,
  piConfiguredModelLabel,
  piConfiguredModels,
  codexCompatibleCanKeepKey,
  codexCompatibleOriginChanged,
  piExtraProviderOption,
  piInitialProviderChoice,
  reasoningFieldState,
  runtimeModels,
  runtimeRequiresModel,
  splitCustomModel,
  submittedRuntimeModel,
  type RuntimeOptions,
  type RuntimeProviderNoticeContext,
  type RuntimeSelection,
} from "./agent-runtime-fields-state";
import { AgentRuntimeModelField } from "./agent-runtime-model-field";
import { AgentRuntimeProviderSelect } from "./agent-runtime-provider-select";
import { useCommandCodeEfforts } from "./use-command-code-efforts";
import { useRuntimeCatalogRefresh } from "./use-runtime-catalog-refresh";

export * from "./agent-runtime-fields-state";

const CUSTOM_MODEL_KEY = "custom-model";
const PINNED_MODEL_CHOICES: ReadonlySet<string> = new Set(["", CUSTOM_MODEL_KEY]);
const EMPTY_PINNED_MODEL_CHOICES: ReadonlySet<string> = new Set();

export function AgentRuntimeFields({
  open,
  computerId,
  initial,
  credentialConfigured = false,
  enforceRequiredModel = false,
  providerError,
  modelProviderError,
  modelError,
  baseUrlError,
  apiKeyError,
  onModelErrorClear,
  onFieldErrorClear,
  onLoad,
  initialOptions,
  onDirtyChange,
  onCodexStateChange,
  providerNotice,
}: {
  open: boolean;
  computerId: string;
  initial?: RuntimeSelection;
  credentialConfigured?: boolean;
  enforceRequiredModel?: boolean;
  providerError?: string;
  modelProviderError?: string;
  modelError?: string;
  baseUrlError?: string;
  apiKeyError?: string;
  onModelErrorClear?: () => void;
  onFieldErrorClear?: (
    field: "provider" | "modelProvider" | "model" | "baseUrl" | "apiKey",
  ) => void;
  onLoad: (computerId: string) => Promise<RuntimeOptions>;
  initialOptions?: RuntimeOptions;
  onDirtyChange?: (dirty: boolean) => void;
  onCodexStateChange?: (state: { isCodex: boolean; isCodexCompatible: boolean }) => void;
  providerNotice?: (context: RuntimeProviderNoticeContext) => ReactNode;
}) {
  const controlSize = useDialogControlSize();
  const initialCodexCompatible = selectsCodexCompatible(
    initial?.provider ?? "",
    initial?.modelProvider,
  );
  const [provider, setProvider] = useState(initial?.provider ?? RUNTIME_PROVIDER.COFORGE);
  const [modelProvider, setModelProvider] = useState(initial?.modelProvider ?? "");
  const [piProviderChoice, setPiProviderChoice] = useState(() =>
    piInitialProviderChoice(initial, credentialConfigured),
  );
  const piExtraProvider = piExtraProviderOption(initial, credentialConfigured);
  const initialModelKey = initial?.model
    ? `${encodeURIComponent(initial.modelProvider ?? "")}--${encodeURIComponent(initial.model)}`
    : "";
  const [modelKey, setModelKey] = useState(initialModelKey);
  const [customModelActive, setCustomModelActive] = useState(false);
  const [customModelText, setCustomModelText] = useState("");
  const [codexModel, setCodexModel] = useState(
    initialCodexCompatible ? (initial?.model ?? "") : "",
  );
  const [baseUrl, setBaseUrl] = useState(initialCodexCompatible ? (initial?.baseUrl ?? "") : "");
  const [reasoning, setReasoning] = useState(initial?.reasoning ?? "");
  const [fastMode, setFastMode] = useState(initial?.fastMode ?? false);
  const [sizes, setSizes] = useState(() => initialModelSizes(initial));
  const [apiKey, setApiKey] = useState("");
  const [manualDirty, setManualDirty] = useState(false);
  const [optionsByComputer, setOptionsByComputer] = useState<
    Record<string, RuntimeOptions | undefined>
  >(() => (initialOptions ? { [computerId]: initialOptions } : {}));
  const [failedComputerId, setFailedComputerId] = useState<string>();
  const [retry, setRetry] = useState(0);
  const loading = useRef(new Set<string>());
  const previousComputerId = useRef(computerId);
  const catalogRefresh = useRuntimeCatalogRefresh({
    open,
    computerId,
    provider,
    isLoading: (id) => loading.current.has(id),
    setOptions: setOptionsByComputer,
  });
  const options = optionsByComputer[computerId];
  const failed = failedComputerId === computerId;
  const isPi = provider === RUNTIME_PROVIDER.PI;
  const piConfigured = isPi && piProviderChoice === "";
  const piBuiltin = isPi && !piConfigured;
  const sizesApply = modelSizesApply(provider, piBuiltin ? piProviderChoice : "");
  const isCodex = provider === RUNTIME_PROVIDER.CODEX;
  const queriedCodexCompatible = useCodexCompatibleSupport(
    computerId,
    open && isCodex && options?.codexCompatible === undefined,
  );
  const codexCompatibleSupported = options?.codexCompatible ?? queriedCodexCompatible;
  const showCodexCompatibleSection =
    isCodex && !failed && (codexCompatibleSupported || initialCodexCompatible);
  const isCodexCompatible =
    showCodexCompatibleSection && selectsCodexCompatible(provider, modelProvider);

  useEffect(() => {
    if (!open) setApiKey("");
  }, [open]);

  useEffect(() => {
    if (previousComputerId.current !== computerId) {
      setApiKey("");
    }
    previousComputerId.current = computerId;
  }, [computerId]);

  useEffect(() => {
    if (!open || !computerId || options || failed || loading.current.has(computerId)) return;
    loading.current.add(computerId);
    void onLoad(computerId)
      .then((value) => {
        setOptionsByComputer((current) => ({
          ...current,
          [computerId]: value,
        }));
        setFailedComputerId((current) => (current === computerId ? undefined : current));
        if (initial?.model) {
          const catalog = value.catalogs.find((item) => item.provider === initial.provider);
          const model = catalog?.models.find(
            (item) => item.id === initial.model && item.modelProvider === initial.modelProvider,
          );
          if (model) setModelKey(modelOptionValue(model));
        }
      })
      .catch(() => setFailedComputerId(computerId))
      .finally(() => {
        loading.current.delete(computerId);
      });
  }, [computerId, failed, initial, onLoad, open, options, retry]);

  const providers = new Set([
    RUNTIME_PROVIDER.COFORGE,
    initial?.provider,
    ...(options?.providers ?? []),
  ]);

  const configuredModelSelected = Boolean(
    initial?.model && provider === initial.provider && modelKey === initialModelKey,
  );

  useEffect(() => {
    if (!options || customModelActive) return;
    if (!(piConfigured && configuredModelSelected)) return;
    if (
      isPiCustomModel(piConfiguredModels(options), initial?.modelProvider, initial?.model ?? "")
    ) {
      setCustomModelActive(true);
      setCustomModelText(joinCustomModel(initial?.modelProvider, initial?.model ?? ""));
    }
  }, [options, piConfigured, configuredModelSelected, initial, customModelActive]);

  const catalogModels = isPi
    ? piBuiltin
      ? piBuiltinModels(options, piProviderChoice)
      : piConfiguredModels(options)
    : runtimeModels(options, provider);
  const modelProviders = [
    ...new Set(
      catalogModels
        .map((model) => model.modelProvider)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const selectedModel = catalogModels.find(
    (model) =>
      modelOptionValue(model) === modelKey &&
      (provider !== RUNTIME_PROVIDER.COFORGE || model.modelProvider === modelProvider),
  );
  const configuredModelLabel = configuredModelSelected
    ? selectedModel?.displayName || initial?.model
    : undefined;
  const customSplit = customModelActive ? splitCustomModel(customModelText) : undefined;
  const customInvalid = customModelActive && customModelText.trim() !== "" && !customSplit;
  const { modelProvider: submittedModelProvider, model: submittedModel } = submittedRuntimeModel({
    provider,
    modelProvider,
    piBuiltin,
    piProviderChoice,
    customModelActive,
    customSplit,
    selectedModel,
    modelKey,
    initialModelKey,
    codexModel,
    initial,
  });
  const matchingConfiguredCredential =
    credentialConfigured &&
    initial?.provider === provider &&
    initial.modelProvider === submittedModelProvider;
  const modelRequired =
    enforceRequiredModel && runtimeRequiresModel(provider, submittedModelProvider);
  const pinnedModelChoices = modelRequired ? EMPTY_PINNED_MODEL_CHOICES : PINNED_MODEL_CHOICES;
  const visibleModels = catalogModels.filter((model) => {
    if (provider === RUNTIME_PROVIDER.COFORGE) return model.modelProvider === modelProvider;
    return true;
  });
  const modelChoices: ModelChoice[] = [
    ...(!modelRequired
      ? [
          {
            id: "",
            label: piConfigured
              ? m.agent_form_pi_provider_configured()
              : m.agent_form_provider_default(),
          },
        ]
      : []),
    ...(configuredModelSelected && !selectedModel && !(piConfigured && customModelActive)
      ? [{ id: initialModelKey, label: configuredModelLabel ?? "" }]
      : []),
    ...visibleModels.map((model) => ({
      id: modelOptionValue(model),
      label: piConfigured ? piConfiguredModelLabel(model) : model.displayName,
      keywords: [model.id, model.description],
    })),
    ...(piConfigured ? [{ id: CUSTOM_MODEL_KEY, label: m.agent_form_model_custom() }] : []),
  ];
  const modelValue = submittedModel;
  const effortModelId =
    provider === RUNTIME_PROVIDER.COMMAND_CODE && !failed ? (modelValue ?? "").trim() : "";
  const readEfforts = useCommandCodeEfforts({ open, computerId, modelId: effortModelId });
  const efforts = effortModelId ? readEfforts : selectedModel?.reasoningEfforts;
  const { visible: reasoningVisible, submitted: submittedReasoning } = reasoningFieldState(
    efforts,
    reasoning,
  );
  const { visible: fastModeVisible, submitted: submittedFastMode } = fastModeFieldState(
    provider,
    fastMode,
  );
  const apiKeyProviderId = piBuiltin ? piProviderChoice : modelProvider;
  const showApiKeyField =
    !RUNTIME_PROVIDER_USES_EXTERNAL_CLI[provider] &&
    (piBuiltin || (provider !== RUNTIME_PROVIDER.PI && KEYED_MODEL_PROVIDERS.has(modelProvider)));
  const dirty = isRuntimeDirty({
    manualDirty,
    apiKey,
    provider,
    submittedModelProvider,
    modelValue: modelValue ?? "",
    submittedReasoning,
    submittedFastMode,
    sizes,
    sizesApply,
    baseUrl: isCodexCompatible ? baseUrl : "",
    initial,
  });

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    onCodexStateChange?.({ isCodex, isCodexCompatible });
  }, [isCodex, isCodexCompatible, onCodexStateChange]);

  function resetModelFields() {
    setModelKey("");
    setCustomModelActive(false);
    setCustomModelText("");
    setCodexModel("");
    setBaseUrl("");
    setReasoning("");
    setFastMode(false);
    setSizes(initialModelSizes());
    setApiKey("");
  }

  return (
    <>
      <input type="hidden" name="provider" value={provider} />
      <AgentRuntimeProviderSelect
        provider={provider}
        providers={providers}
        unusable={options?.unusable}
        error={providerError}
        className="min-w-0"
        onChange={(key) => {
          setProvider(parseRuntimeProvider(key) ?? RUNTIME_PROVIDER.COFORGE);
          setModelProvider("");
          setPiProviderChoice("");
          resetModelFields();
          onModelErrorClear?.();
          onFieldErrorClear?.("provider");
          onFieldErrorClear?.("modelProvider");
          onFieldErrorClear?.("model");
          onFieldErrorClear?.("baseUrl");
          onFieldErrorClear?.("apiKey");
        }}
      />
      {providerNotice?.({
        provider,
        modelProvider: submittedModelProvider,
        codexCompatibleSupported,
        onUseCodexCompatible: () => {
          setModelProvider(CODEX_COMPATIBLE_MODEL_PROVIDER);
          resetModelFields();
          onModelErrorClear?.();
          onFieldErrorClear?.("modelProvider");
          onFieldErrorClear?.("model");
          onFieldErrorClear?.("baseUrl");
          onFieldErrorClear?.("apiKey");
        },
      })}
      <AgentRuntimeModelProviderField
        failed={failed}
        provider={provider}
        controlSize={controlSize}
        modelProvider={modelProvider}
        modelProviderError={modelProviderError}
        submittedModelProvider={submittedModelProvider}
        optionsLoaded={Boolean(options)}
        isPi={isPi}
        piProviderChoice={piProviderChoice}
        piExtraProvider={piExtraProvider}
        modelProviders={modelProviders}
        onManualChange={() => {
          setApiKey("");
          setManualDirty(true);
          onFieldErrorClear?.("modelProvider");
          onFieldErrorClear?.("apiKey");
        }}
        onSelectChange={(value) => {
          if (isPi) setPiProviderChoice(value);
          else setModelProvider(value);
          resetModelFields();
          onFieldErrorClear?.("modelProvider");
          onFieldErrorClear?.("model");
          onFieldErrorClear?.("apiKey");
        }}
      />
      {showCodexCompatibleSection && (
        <AgentCodexCompatibleFields
          controlSize={controlSize}
          showModeSelect={codexCompatibleSupported}
          modelProvider={modelProvider}
          model={codexModel}
          modelError={modelError}
          baseUrl={baseUrl}
          baseUrlError={baseUrlError}
          apiKey={apiKey}
          apiKeyError={apiKeyError}
          canKeepKey={codexCompatibleCanKeepKey(initial, baseUrl)}
          originChanged={codexCompatibleOriginChanged(initial, baseUrl)}
          onModeChange={(next) => {
            setModelProvider(next);
            resetModelFields();
            onModelErrorClear?.();
            onFieldErrorClear?.("modelProvider");
            onFieldErrorClear?.("model");
            onFieldErrorClear?.("baseUrl");
            onFieldErrorClear?.("apiKey");
          }}
          onModelChange={(value) => {
            setCodexModel(value);
            onModelErrorClear?.();
            onFieldErrorClear?.("model");
          }}
          onBaseUrlChange={(value) => {
            setBaseUrl(value);
            onFieldErrorClear?.("baseUrl");
          }}
          onApiKeyChange={(value) => {
            setApiKey(value);
            onFieldErrorClear?.("apiKey");
          }}
        />
      )}
      <AgentRuntimeModelField
        failed={failed}
        isCodexCompatible={isCodexCompatible}
        controlSize={controlSize}
        modelRequired={modelRequired}
        modelError={modelError}
        initialModel={initial?.model}
        modelValue={modelValue}
        optionsLoaded={Boolean(options)}
        refresh={{
          run: () => void catalogRefresh.refresh(),
          busy: catalogRefresh.busy,
          refreshing: catalogRefresh.refreshing,
        }}
        modelChoices={modelChoices}
        pinnedModelChoices={pinnedModelChoices}
        selectedKey={piConfigured && customModelActive ? CUSTOM_MODEL_KEY : modelKey}
        catalogRefreshNote={catalogRefresh.note}
        provider={provider}
        onManualChange={() => {
          setManualDirty(true);
          onModelErrorClear?.();
          onFieldErrorClear?.("model");
        }}
        onSelectionChange={(value) => {
          onModelErrorClear?.();
          onFieldErrorClear?.("model");
          if (piConfigured && value === CUSTOM_MODEL_KEY) {
            setCustomModelActive(true);
            setModelKey("");
            setReasoning("");
            return;
          }
          setCustomModelActive(false);
          setModelKey(value);
          const model = catalogModels.find((item) => modelOptionValue(item) === value);
          if (!isPi) {
            if (model?.modelProvider !== modelProvider) setApiKey("");
            setModelProvider(model?.modelProvider ?? "");
          }
          setReasoning(
            value === initialModelKey && provider === initial?.provider
              ? initial.reasoning
              : (model?.defaultReasoning ?? ""),
          );
        }}
      />
      {piConfigured && customModelActive && (
        <AgentRuntimeCustomModelField
          controlSize={controlSize}
          value={customModelText}
          invalid={customInvalid}
          onChange={setCustomModelText}
        />
      )}
      {showApiKeyField && (
        <AgentRuntimeApiKeyField
          controlSize={controlSize}
          provider={provider}
          apiKeyProviderId={apiKeyProviderId}
          apiKey={apiKey}
          apiKeyError={apiKeyError}
          matchingConfiguredCredential={matchingConfiguredCredential}
          onChange={setApiKey}
          onErrorClear={() => onFieldErrorClear?.("apiKey")}
        />
      )}
      {failed && (
        <RuntimeCatalogLoadFailure
          controlSize={controlSize}
          onRetry={() => {
            setFailedComputerId(undefined);
            setOptionsByComputer((current) => ({
              ...current,
              [computerId]: undefined,
            }));
            setRetry((value) => value + 1);
          }}
        />
      )}
      <input type="hidden" name="reasoning" value={submittedReasoning} />
      <input type="hidden" name="fastMode" value={submittedFastMode ? "true" : ""} />
      {reasoningVisible && (
        <AgentReasoningField
          efforts={efforts ?? []}
          value={submittedReasoning}
          onChange={setReasoning}
        />
      )}
      {fastModeVisible && <AgentFastModeField isSelected={fastMode} onChange={setFastMode} />}
      {sizesApply && (
        <AgentModelSizeFields
          value={sizes}
          model={selectedModel}
          size={controlSize}
          onChange={setSizes}
        />
      )}
    </>
  );
}
