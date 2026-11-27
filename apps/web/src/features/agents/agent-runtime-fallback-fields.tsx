import { RUNTIME_PROVIDER, type RuntimeProvider } from "@lrm/coforge-sdk/internal";

import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { useDialogControlSize } from "#src/components/ui/dialog-actions";
import { m } from "#src/paraglide/messages";

export function AgentRuntimeApiKeyField({
  controlSize,
  provider,
  apiKeyProviderId,
  apiKey,
  matchingConfiguredCredential,
  onChange,
}: {
  controlSize: ReturnType<typeof useDialogControlSize>;
  provider: RuntimeProvider;
  apiKeyProviderId: string;
  apiKey: string;
  matchingConfiguredCredential: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Input
      label={m.agent_runtime_api_key({ provider: apiKeyProviderId })}
      size={controlSize}
      className="min-w-0"
      name="apiKey"
      type="password"
      value={apiKey}
      onChange={onChange}
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
