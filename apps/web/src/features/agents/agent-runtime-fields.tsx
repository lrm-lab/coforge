import { useEffect, useRef, useState } from "react";
import { RefreshCw01 } from "@untitledui/icons";
import { Spinner } from "#src/components/ui/spinner";
import {
  parseRuntimeProvider,
  RUNTIME_PROVIDER,
  RUNTIME_PROVIDER_USES_EXTERNAL_CLI,
} from "@lrm/coforge-sdk/internal";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import { m } from "#src/paraglide/messages";
import { AgentFastModeField } from "./agent-fast-mode-field";
import { AgentReasoningField } from "./agent-reasoning-field";
import { KEYED_MODEL_PROVIDERS, PI_BUILTIN_MODEL_PROVIDERS } from "./agent.schemas";
import { modelProviderDisplayName } from "./model-provider-display";
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
  splitCustomModel,
  type RuntimeOptions,
  type RuntimeSelection,
} from "./agent-runtime-fields-state";
import { RUNTIME_PROVIDER_DISPLAY_ORDER, runtimeProviderLabel } from "./runtime-provider-display";
import { RuntimeProviderMark } from "./runtime-provider-mark";
import { useCommandCodeEfforts } from "./use-command-code-efforts";
import { useRuntimeCatalogRefresh } from "./use-runtime-catalog-refresh";

export * from "./agent-runtime-fields-state";

/** The Model select's "let the built-in provider/Pi choose" sentinel and the Configured list's
 * "type it in myself" sentinel. Neither collides with a real `modelOptionValue` (which always
 * contains "--"), and both stay free of the CSS-selector-special characters `modelOptionValue`
 * itself has to avoid. */
const CUSTOM_MODEL_KEY = "custom-model";

export function AgentRuntimeFields({
  open,
  computerId,
  initial,
  credentialConfigured = false,
  onLoad,
  onDirtyChange,
}: {
  open: boolean;
  computerId: string;
  initial?: RuntimeSelection;
  credentialConfigured?: boolean;
  onLoad: (computerId: string) => Promise<RuntimeOptions>;
  /** Fires with the current "would this Save do anything" state whenever a field the user can
   * actually change moves away from (or back to) `initial`. `AgentRuntimeFields` keeps owning
   * every field's state; this is only a notification, not a hook for the caller to drive values
   * (the Profile panel's edit dialog uses it to disable Save until something changed). */
  onDirtyChange?: (dirty: boolean) => void;
}) {
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
  const [apiKey, setApiKey] = useState("");
  // Only the catalog-load-failed fallback below renders plain, uncontrolled text `Input`s for
  // modelProvider/model instead of the tracked `Select`s; their own `onChange` marks this so
  // `dirty` still notices a manual edit in that fallback.
  const [manualDirty, setManualDirty] = useState(false);
  const [optionsByComputer, setOptionsByComputer] = useState<
    Record<string, RuntimeOptions | undefined>
  >({});
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

  // A saved Pi Configured pick whose model the Computer's Pi catalog no longer reports (or never
  // did) opens as Custom, prefilled, rather than silently falling back to "Configured default".
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
  const submittedModelProvider = piBuiltin
    ? piProviderChoice
    : provider === RUNTIME_PROVIDER.COFORGE
      ? modelProvider
      : customModelActive
        ? (customSplit?.modelProvider ?? "")
        : (selectedModel?.modelProvider ??
          (modelKey === initialModelKey ? (initial?.modelProvider ?? "") : ""));
  const matchingConfiguredCredential =
    credentialConfigured &&
    initial?.provider === provider &&
    initial.modelProvider === submittedModelProvider;
  const visibleModels = catalogModels.filter((model) => {
    if (provider === RUNTIME_PROVIDER.COFORGE) return model.modelProvider === modelProvider;
    return true;
  });
  const modelValue = customModelActive
    ? (customSplit?.model ?? "")
    : (selectedModel?.id ?? (modelKey === initialModelKey ? initial?.model : ""));
  // Command Code's catalog carries no efforts; they are read for the selected model.
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
    setApiKey("");
  }

  return (
    <>
      <input type="hidden" name="provider" value={provider} />
      <Select
        label={m.agent_form_provider()}
        size="md"
        className="min-w-0"
        selectedKey={provider}
        onSelectionChange={(key) => {
          if (key === null) return;
          setProvider(parseRuntimeProvider(key) ?? RUNTIME_PROVIDER.COFORGE);
          setModelProvider("");
          setPiProviderChoice("");
          resetModelFields();
        }}
      >
        <Select.Item
          id={RUNTIME_PROVIDER.COFORGE}
          label={runtimeProviderLabel(RUNTIME_PROVIDER.COFORGE)}
          icon={<RuntimeProviderMark provider={RUNTIME_PROVIDER.COFORGE} />}
        />
        {RUNTIME_PROVIDER_DISPLAY_ORDER.filter((candidate) => providers.has(candidate)).map(
          (candidate) => (
            <Select.Item
              key={candidate}
              id={candidate}
              label={runtimeProviderLabel(candidate)}
              icon={<RuntimeProviderMark provider={candidate} />}
            />
          ),
        )}
      </Select>
      {failed ? (
        <Input
          label={m.agent_form_model_provider()}
          name="modelProvider"
          size="md"
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
          size="md"
          className="min-w-0"
          isDisabled={!options}
          // The Pi provider picker carries no hint: the sentence that used to sit here explained
          // Configured by contrast with the key-passing choices, which the picker and the API-key
          // field already say on their own.
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
          size="md"
          isRequired
          maxLength={200}
          defaultValue={initial?.model}
          className="min-w-0"
          onChange={() => setManualDirty(true)}
        />
      ) : (
        <>
          <input type="hidden" name="model" value={modelValue} />
          <div className="relative min-w-0">
            <Select
              label={m.agent_form_model()}
              size="md"
              wrapValue
              className="min-w-0 [&_[data-label]]:pr-8"
              popoverClassName="min-w-(--trigger-width) w-max max-w-[min(36rem,calc(100vw-3rem))]"
              isDisabled={!options}
              selectedKey={piConfigured && customModelActive ? CUSTOM_MODEL_KEY : modelKey}
              onSelectionChange={(key) => {
                if (key === null) return;
                const value = String(key);
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
                // The Agent's own model comes back with its saved level, not the model default.
                setReasoning(
                  value === initialModelKey && provider === initial?.provider
                    ? initial.reasoning
                    : (model?.defaultReasoning ?? ""),
                );
              }}
            >
              <Select.Item
                id=""
                label={
                  piConfigured
                    ? m.agent_form_pi_provider_configured()
                    : m.agent_form_provider_default()
                }
              />
              {configuredModelSelected &&
                !selectedModel &&
                !(piConfigured && customModelActive) && (
                  <Select.Item id={initialModelKey} label={configuredModelLabel} />
                )}
              {visibleModels.map((model) => (
                <Select.Item
                  key={modelOptionValue(model)}
                  id={modelOptionValue(model)}
                  className="[&_[slot=label]]:whitespace-normal [&_[slot=label]]:wrap-break-word"
                  label={piConfigured ? piConfiguredModelLabel(model) : model.displayName}
                />
              ))}
              {piConfigured && (
                <Select.Item id={CUSTOM_MODEL_KEY} label={m.agent_form_model_custom()} />
              )}
            </Select>
            <div className="absolute top-0 right-0 flex h-5 items-center">
              <ButtonUtility
                icon={catalogRefresh.refreshing ? Spinner : RefreshCw01}
                size="xs"
                color="tertiary"
                tooltip={m.agent_form_model_refresh()}
                onClick={() => void catalogRefresh.refresh()}
                isDisabled={catalogRefresh.busy || !options}
              />
            </div>
          </div>
          {catalogRefresh.failed && (
            <p role="alert" className="text-sm text-error-primary">
              {m.agent_form_model_refresh_failed()}
            </p>
          )}
        </>
      )}
      {piConfigured && customModelActive && (
        <Input
          label={m.agent_form_model_custom_id()}
          size="md"
          className="min-w-0"
          placeholder="provider/model-id"
          value={customModelText}
          onChange={setCustomModelText}
          // Native validation blocks the form submit: an empty or slash-less entry would
          // otherwise submit no model and silently save "Configured default".
          isRequired
          validate={(value) => (splitCustomModel(value) ? null : m.agent_form_model_custom_error())}
          isInvalid={customInvalid}
          hint={customInvalid ? m.agent_form_model_custom_error() : undefined}
        />
      )}
      {showApiKeyField && (
        <Input
          label={m.agent_runtime_api_key({ provider: apiKeyProviderId })}
          size="md"
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
            size="sm"
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
    </>
  );
}
