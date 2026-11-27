import {
  RUNTIME_PROVIDER,
  RUNTIME_PROVIDER_USES_EXTERNAL_CLI,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";

import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import { useDialogControlSize } from "#src/components/ui/dialog-actions";
import { fieldHint } from "#src/lib/form-field-error";
import { m } from "#src/paraglide/messages";

import { PI_BUILTIN_MODEL_PROVIDERS } from "./agent.schemas";
import { splitCustomModel } from "./agent-runtime-fields-state";
import { modelProviderDisplayName } from "./model-provider-display";

export function AgentRuntimeApiKeyField({
  controlSize,
  provider,
  apiKeyProviderId,
  apiKey,
  apiKeyError,
  matchingConfiguredCredential,
  onChange,
  onErrorClear,
}: {
  controlSize: ReturnType<typeof useDialogControlSize>;
  provider: RuntimeProvider;
  apiKeyProviderId: string;
  apiKey: string;
  apiKeyError?: string;
  matchingConfiguredCredential: boolean;
  onChange: (value: string) => void;
  onErrorClear?: () => void;
}) {
  return (
    <Input
      label={m.agent_runtime_api_key({ provider: apiKeyProviderId })}
      size={controlSize}
      className="min-w-0"
      name="apiKey"
      type="password"
      value={apiKey}
      onChange={(value) => {
        onChange(value);
        onErrorClear?.();
      }}
      isRequired={!matchingConfiguredCredential}
      isInvalid={Boolean(apiKeyError)}
      minLength={8}
      maxLength={4096}
      autoComplete="new-password"
      placeholder={m.agent_runtime_api_key_placeholder({ provider: apiKeyProviderId })}
      hint={fieldHint(
        apiKeyError,
        matchingConfiguredCredential
          ? m.agent_form_api_key_preserve_help()
          : provider === RUNTIME_PROVIDER.PI
            ? m.agent_form_pi_api_key_help()
            : m.agent_form_coforge_api_key_help(),
      )}
    />
  );
}

export function RuntimeCatalogLoadFailure({
  controlSize,
  onRetry,
}: {
  controlSize: ReturnType<typeof useDialogControlSize>;
  onRetry: () => void;
}) {
  return (
    <div role="alert" className="grid gap-2">
      <p className="text-sm text-error-primary">{m.agent_form_catalog_manual_help()}</p>
      <Button
        type="button"
        color="secondary"
        size={controlSize}
        className="justify-self-start"
        onPress={onRetry}
      >
        {m.controls_retry()}
      </Button>
    </div>
  );
}

export function AgentRuntimeModelProviderField({
  failed,
  provider,
  controlSize,
  modelProvider,
  modelProviderError,
  submittedModelProvider,
  optionsLoaded,
  isPi,
  piProviderChoice,
  piExtraProvider,
  modelProviders,
  onManualChange,
  onSelectChange,
}: {
  failed: boolean;
  provider: RuntimeProvider;
  controlSize: ReturnType<typeof useDialogControlSize>;
  modelProvider: string;
  modelProviderError?: string;
  submittedModelProvider: string;
  optionsLoaded: boolean;
  isPi: boolean;
  piProviderChoice: string;
  piExtraProvider?: string;
  modelProviders: readonly string[];
  onManualChange: () => void;
  onSelectChange: (value: string) => void;
}) {
  return (
    <>
      {failed ? (
        <Input
          label={m.agent_form_model_provider()}
          name="modelProvider"
          size={controlSize}
          isRequired={provider === RUNTIME_PROVIDER.COFORGE}
          isInvalid={Boolean(modelProviderError)}
          hint={fieldHint(modelProviderError)}
          maxLength={100}
          defaultValue={modelProvider}
          onChange={onManualChange}
        />
      ) : (
        <input type="hidden" name="modelProvider" value={submittedModelProvider} />
      )}
      {!failed && !RUNTIME_PROVIDER_USES_EXTERNAL_CLI[provider] && (
        <div data-field="modelProvider" className="min-w-0">
          <Select
            label={m.agent_form_model_provider()}
            size={controlSize}
            className="min-w-0"
            isDisabled={!optionsLoaded}
            isInvalid={Boolean(modelProviderError)}
            hint={modelProviderError}
            selectedKey={isPi ? piProviderChoice : modelProvider}
            onSelectionChange={(key) => {
              if (key === null) return;
              onSelectChange(String(key));
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
        </div>
      )}
    </>
  );
}

export function AgentRuntimeCustomModelField({
  controlSize,
  value,
  invalid,
  onChange,
}: {
  controlSize: ReturnType<typeof useDialogControlSize>;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Input
      label={m.agent_form_model_custom_id()}
      size={controlSize}
      className="min-w-0"
      placeholder="provider/model-id"
      value={value}
      onChange={onChange}
      isRequired
      validate={(next) => (splitCustomModel(next) ? null : m.agent_form_model_custom_error())}
      isInvalid={invalid}
      hint={fieldHint(invalid ? m.agent_form_model_custom_error() : undefined)}
    />
  );
}
