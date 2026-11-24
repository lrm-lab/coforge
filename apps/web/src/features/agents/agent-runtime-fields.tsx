import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  parseRuntimeProvider,
  RUNTIME_PROVIDER,
  RUNTIME_PROVIDER_USES_EXTERNAL_CLI,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";

import { Button } from "#src/components/base/buttons/button";
import { useDialogControlSize } from "#src/components/ui/dialog-actions";
import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import { m } from "#src/paraglide/messages";
import { AgentFastModeField } from "./agent-fast-mode-field";
import { AgentModelSizeFields } from "./agent-model-size-fields";
import { initialModelSizes, modelSizesApply } from "./agent-model-sizes";
import { AgentReasoningField } from "./agent-reasoning-field";
import { KEYED_MODEL_PROVIDERS, PI_BUILTIN_MODEL_PROVIDERS } from "./agent.schemas";
import { ModelComboBox } from "./model-combobox";
import { modelProviderDisplayName } from "./model-provider-display";
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
  piExtraProviderOption,
  piInitialProviderChoice,
  reasoningFieldState,
  runtimeModels,
  runtimeRequiresModel,
  splitCustomModel,
  submittedRuntimeModel,
  type RuntimeOptions,
  type RuntimeSelection,
} from "./agent-runtime-fields-state";
import { AgentRuntimeProviderSelect } from "./agent-runtime-provider-select";
import { useCommandCodeEfforts } from "./use-command-code-efforts";
import { useRuntimeCatalogRefresh } from "./use-runtime-catalog-refresh";
import { RuntimeRefreshOutcome } from "./runtime-refresh-outcome";

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
  modelError,
  onModelErrorClear,
  onLoad,
  initialOptions,
  onDirtyChange,
  providerNotice,
}: {
  open: boolean;
  computerId: string;
  initial?: RuntimeSelection;
  credentialConfigured?: boolean;
  enforceRequiredModel?: boolean;
  modelError?: string;
  onModelErrorClear?: () => void;
  onLoad: (computerId: string) => Promise<RuntimeOptions>;
  initialOptions?: RuntimeOptions;
  onDirtyChange?: (dirty: boolean) => void;
  providerNotice?: (provider: RuntimeProvider) => ReactNode;
}) {
  const controlSize = useDialogControlSize();
  const [provider, setProvider] = useState(initial?.provider ?? RUNTIME_PROVIDER.COFORGE);
  const [modelProvider, setModelProvider] = useState(initial?.modelProvider ?? "");
  const [piProviderChoice, setPiProviderChoice] = useState(
    piInitialProviderChoice(initial, credentialConfigured),
  );
  const piExtraProvider = piExtraProviderOption(initial, credentialConfigured);
  const initialModelKey = initial?.model
    ? `${encodeURIComponent(initial.modelProvider ?? "")}--${encodeURIComponent(initial.model)}`
    : "";
  const [modelKey, setModelKey] = useState(initialModelKey);
  const [customModelActive, setCustomModelActive] = useState(false);
  const [customModelText, setCustomModelText] = useState("");
  const [reasoning, setReasoning] = useState(initial?.reasoning ?? "");
  const [fastMode, setFastMode] = useState(initial?.fastMode ?? false);
  const [sizes, setSizes] = useState(initialModelSizes(initial));
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
    initial,
  });
  const matchingConfiguredCredential =
    credentialConfigured &&
    initial?.provider === provider &&
    initial.modelProvider === submittedModelProvider;
  const modelRequired = enforceRequiredModel && runtimeRequiresModel(provider);
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
    initial,
  });

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  function resetModelFields() {
    setModelKey("");
    setCustomModelActive(false);
    setCustomModelText("");
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
        className="min-w-0"
        onChange={(key) => {
          setProvider(parseRuntimeProvider(key) ?? RUNTIME_PROVIDER.COFORGE);
          setModelProvider("");
          setPiProviderChoice("");
          resetModelFields();
          onModelErrorClear?.();
        }}
      />
      {providerNotice?.(provider)}
      {failed ? (
        <Input
          label={m.agent_form_model_provider()}
          name="modelProvider"
          size={controlSize}
          isRequired={provider === RUNTIME_PROVIDER.COFORGE}
          maxLength={100}
          defaultValue={modelProvider}
          onChange={() => {
            setApiKey("");
            setManualDirty(true);
          }}
        />
      ) : (
        <input type="hidden" name="modelProvider" value={submittedModelProvider} />
      )}
      {!failed && !RUNTIME_PROVIDER_USES_EXTERNAL_CLI[provider] && (
        <Select
          label={m.agent_form_model_provider()}
          size={controlSize}
          className="min-w-0"
          isDisabled={!options}
          selectedKey={isPi ? piProviderChoice : modelProvider}
          onSelectionChange={(key) => {
            if (key === null) return;
            const value = String(key);
            if (isPi) setPiProviderChoice(value);
            else setModelProvider(value);
            resetModelFields();
          }}
        >
          {isPi ? (
            <>
              <Select.Item id="" label={m.agent_form_pi_provider_configured()} />
              {PI_BUILTIN_MODEL_PROVIDERS.map((value) => (
                <Select.Item key={value} id={value} label={modelProviderDisplayName(value)} />
              ))}
              {piExtraProvider && (
                <Select.Item key={piExtraProvider} id={piExtraProvider} label={piExtraProvider} />
              )}
            </>
          ) : (
            <>
              <Select.Item id="" label={m.agent_form_provider_default()} />
              {modelProviders.map((value) => (
                <Select.Item key={value} id={value} label={value} />
              ))}
            </>
          )}
        </Select>
      )}
      {failed ? (
        <Input
          label={m.agent_form_model()}
          name="model"
          size={controlSize}
          isRequired
          validationBehavior={modelRequired ? "aria" : undefined}
          isInvalid={Boolean(modelError)}
          hint={modelError || undefined}
          maxLength={200}
          defaultValue={initial?.model}
          className="min-w-0"
          onChange={() => {
            setManualDirty(true);
            onModelErrorClear?.();
          }}
        />
      ) : (
        <>
          <input type="hidden" name="model" value={modelValue} />
          <div className="relative min-w-0">
            <ModelComboBox
              label={m.agent_form_model()}
              className="min-w-0"
              popoverClassName="min-w-(--trigger-width) w-max max-w-[min(36rem,calc(100vw-3rem))]"
              isDisabled={!options}
              isRequired={modelRequired}
              isInvalid={Boolean(modelError)}
              hint={modelError || undefined}
              refresh={{
                run: () => void catalogRefresh.refresh(),
                busy: catalogRefresh.busy,
                refreshing: catalogRefresh.refreshing,
              }}
              choices={modelChoices}
              pinned={pinnedModelChoices}
              selectedKey={piConfigured && customModelActive ? CUSTOM_MODEL_KEY : modelKey}
              onSelectionChange={(value) => {
                onModelErrorClear?.();
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
          </div>
          {catalogRefresh.note && (
            <RuntimeRefreshOutcome note={catalogRefresh.note} runtime={provider} />
          )}
        </>
      )}
      {piConfigured && customModelActive && (
        <Input
          label={m.agent_form_model_custom_id()}
          size={controlSize}
          className="min-w-0"
          placeholder="provider/model-id"
          value={customModelText}
          onChange={setCustomModelText}
          isRequired
          validate={(value) => (splitCustomModel(value) ? null : m.agent_form_model_custom_error())}
          isInvalid={customInvalid}
          hint={customInvalid ? m.agent_form_model_custom_error() : undefined}
        />
      )}
      {showApiKeyField && (
        <Input
          label={m.agent_runtime_api_key({ provider: apiKeyProviderId })}
          size={controlSize}
          className="min-w-0"
          name="apiKey"
          type="password"
          value={apiKey}
          onChange={setApiKey}
          isRequired={!matchingConfiguredCredential}
          minLength={8}
          maxLength={4096}
          autoComplete="new-password"
          placeholder={m.agent_runtime_api_key_placeholder({ provider: apiKeyProviderId })}
          hint={
            matchingConfiguredCredential
              ? m.agent_form_api_key_preserve_help()
              : provider === RUNTIME_PROVIDER.PI
                ? m.agent_form_pi_api_key_help()
                : m.agent_form_coforge_api_key_help()
          }
        />
      )}
      {failed && (
        <div role="alert" className="grid gap-2">
          <p className="text-sm text-error-primary">{m.agent_form_catalog_manual_help()}</p>
          <Button
            type="button"
            color="secondary"
            size={controlSize}
            className="justify-self-start"
            onPress={() => {
              setFailedComputerId(undefined);
              setOptionsByComputer((current) => ({
                ...current,
                [computerId]: undefined,
              }));
              setRetry((value) => value + 1);
            }}
          >
            {m.controls_retry()}
          </Button>
        </div>
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
