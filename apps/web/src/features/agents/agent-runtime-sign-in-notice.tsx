import { AlertTriangle, LogIn01 } from "@untitledui/icons";
import type { RuntimeAuthProvider, RuntimeProvider } from "@lrm/coforge-sdk/internal";

import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import { runtimeProviderLabel } from "./runtime-provider-display";
import { runtimeSignInNotice, type RuntimeSignInComputer } from "./agent-runtime-sign-in-state";

export function AgentRuntimeSignInNotice({
  computer,
  provider,
  modelProvider,
  codexCompatibleSupported,
  onUseCodexCompatible,
  onSignIn,
}: {
  computer: RuntimeSignInComputer;
  provider: RuntimeProvider;
  modelProvider?: string;
  codexCompatibleSupported?: boolean;
  onUseCodexCompatible?: () => void;
  onSignIn: (provider: RuntimeAuthProvider) => void;
}) {
  const notice = runtimeSignInNotice(computer, provider, {
    modelProvider,
    codexCompatibleSupported,
  });
  if (!notice) return null;
  const { signInProvider, canUseCodexCompatible } = notice;
  const showApiKeyOption = Boolean(canUseCodexCompatible && onUseCodexCompatible);
  const runtime = runtimeProviderLabel(provider);
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-error-primary p-3 ring-1 ring-error_subtle ring-inset">
      <p className="flex gap-2 text-sm text-primary">
        <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-error-secondary" />
        {showApiKeyOption
          ? m.agent_form_codex_signed_out_or_api_key({
              runtime,
              computer: computer.displayName,
            })
          : m.agent_form_runtime_signed_out({
              runtime,
              computer: computer.displayName,
            })}
      </p>
      {(showApiKeyOption || signInProvider) && (
        <div className="flex flex-wrap justify-end gap-2">
          {showApiKeyOption && (
            <Button type="button" size="sm" color="secondary" onPress={onUseCodexCompatible}>
              {m.agent_form_use_custom_api_key()}
            </Button>
          )}
          {signInProvider && (
            <Button
              type="button"
              size="sm"
              color="secondary"
              iconLeading={LogIn01}
              onPress={() => onSignIn(signInProvider)}
            >
              {m.runtime_auth_sign_in()}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
