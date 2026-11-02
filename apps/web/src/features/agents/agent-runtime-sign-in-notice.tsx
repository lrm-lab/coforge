import { AlertTriangle, LogIn01 } from "@untitledui/icons";
import type { RuntimeAuthProvider, RuntimeProvider } from "@lrm/coforge-sdk/internal";

import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import { runtimeProviderLabel } from "./runtime-provider-display";
import { runtimeSignInNotice, type RuntimeSignInComputer } from "./agent-runtime-sign-in-state";

/**
 * Under the runtime picker, as Raft's create dialog has it: the chosen runtime is not signed in on
 * that Computer, so an Agent made now could not answer. Those who may sign it in (the Computer's
 * owner, a Workspace owner or admin) get Sign in right here; `onSignIn` opens that flow. Shown only
 * for a stored "logged out" report: an unknown or missing one says nothing either way.
 */
export function AgentRuntimeSignInNotice({
  computer,
  provider,
  onSignIn,
}: {
  computer: RuntimeSignInComputer;
  provider: RuntimeProvider;
  onSignIn: (provider: RuntimeAuthProvider) => void;
}) {
  const notice = runtimeSignInNotice(computer, provider);
  if (!notice) return null;
  const { signInProvider } = notice;
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-error-primary p-3 ring-1 ring-error_subtle ring-inset">
      <p className="flex gap-2 text-sm text-primary">
        <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-error-secondary" />
        {m.agent_form_runtime_signed_out({
          runtime: runtimeProviderLabel(provider),
          computer: computer.displayName,
        })}
      </p>
      {signInProvider && (
        <Button
          type="button"
          size="sm"
          color="secondary"
          iconLeading={LogIn01}
          className="self-end"
          onPress={() => onSignIn(signInProvider)}
        >
          {m.runtime_auth_sign_in()}
        </Button>
      )}
    </div>
  );
}
