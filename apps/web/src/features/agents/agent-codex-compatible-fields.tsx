import { useEffect, useState } from "react";
import {
  CODEX_COMPATIBLE_MODEL_PROVIDER,
  codexCompatibleBaseUrl,
} from "@lrm/coforge-sdk/internal/codex-compatible-provider";

import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import { useDialogControlSize } from "#src/components/ui/dialog-actions";
import { m } from "#src/paraglide/messages";

export function AgentCodexCompatibleFields({
  controlSize,
  showModeSelect,
  modelProvider,
  model,
  modelError,
  baseUrl,
  apiKey,
  canKeepKey,
  originChanged,
  onModeChange,
  onModelChange,
  onBaseUrlChange,
  onApiKeyChange,
}: {
  controlSize: ReturnType<typeof useDialogControlSize>;
  showModeSelect: boolean;
  modelProvider: string;
  model: string;
  modelError?: string;
  baseUrl: string;
  apiKey: string;
  canKeepKey: boolean;
  originChanged: boolean;
  onModeChange: (modelProvider: string) => void;
  onModelChange: (model: string) => void;
  onBaseUrlChange: (baseUrl: string) => void;
  onApiKeyChange: (apiKey: string) => void;
}) {
  const isCompatible = modelProvider === CODEX_COMPATIBLE_MODEL_PROVIDER;
  const [baseUrlTouched, setBaseUrlTouched] = useState(false);

  useEffect(() => {
    if (!isCompatible || baseUrl === "") setBaseUrlTouched(false);
  }, [isCompatible, baseUrl]);

  const trimmedBaseUrl = baseUrl.trim();
  const baseUrlInvalid =
    baseUrlTouched && trimmedBaseUrl !== "" && !codexCompatibleBaseUrl(baseUrl);

  return (
    <>
      {showModeSelect && (
        <Select
          label={m.agent_form_model_provider()}
          size={controlSize}
          className="min-w-0"
          selectedKey={isCompatible ? CODEX_COMPATIBLE_MODEL_PROVIDER : ""}
          onSelectionChange={(key) => {
            if (key === null) return;
            onModeChange(String(key));
          }}
        >
          <Select.Item id="" label={m.agent_form_codex_provider_account()} />
          <Select.Item
            id={CODEX_COMPATIBLE_MODEL_PROVIDER}
            label={m.agent_form_codex_provider_compatible()}
          />
        </Select>
      )}
      {isCompatible && (
        <>
          <Input
            label={m.agent_form_model()}
            name="model"
            size={controlSize}
            className="min-w-0"
            isRequired
            maxLength={200}
            placeholder={m.agent_form_codex_model_placeholder()}
            value={model}
            onChange={onModelChange}
            isInvalid={Boolean(modelError)}
            hint={modelError || undefined}
          />
          <Input
            label={m.agent_form_codex_base_url()}
            name="baseUrl"
            type="url"
            autoComplete="url"
            size={controlSize}
            className="min-w-0"
            isRequired
            maxLength={2048}
            placeholder={m.agent_form_codex_base_url_placeholder()}
            value={baseUrl}
            onChange={onBaseUrlChange}
            onBlur={() => setBaseUrlTouched(true)}
            isInvalid={baseUrlInvalid}
            validate={(value) =>
              !value.trim() || codexCompatibleBaseUrl(value)
                ? null
                : m.agent_form_codex_base_url_invalid()
            }
            hint={
              baseUrlInvalid
                ? m.agent_form_codex_base_url_invalid()
                : m.agent_form_codex_base_url_help()
            }
          />
          <Input
            label={m.agent_form_codex_api_key()}
            name="apiKey"
            type="password"
            autoComplete="new-password"
            size={controlSize}
            className="min-w-0"
            isRequired={!canKeepKey}
            minLength={8}
            maxLength={4096}
            placeholder={m.agent_form_codex_api_key_placeholder()}
            value={apiKey}
            onChange={onApiKeyChange}
            hint={
              canKeepKey
                ? m.agent_form_api_key_preserve_help()
                : originChanged
                  ? m.agent_form_codex_api_key_origin_changed_help()
                  : m.agent_form_codex_api_key_help()
            }
          />
        </>
      )}
    </>
  );
}
