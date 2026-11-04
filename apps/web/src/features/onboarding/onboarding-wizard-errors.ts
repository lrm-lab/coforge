import { agentCreateErrorMessage } from "#src/features/agents/agent-form";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";

/** The `errorId` the server answers a wizard action with once setup is already finished. */
export const ONBOARDING_NOT_PENDING = "onboarding-not-pending";

/** The wizard's own refusals worded for the member, then the Agent forms' copy for the rest. */
export function wizardErrorMessage(cause: unknown): string {
  if (isAppError(cause)) {
    if (cause.errorId === "workspace-assistant-already-started")
      return m.onboarding_wizard_error_started();
    if (cause.errorId === ONBOARDING_NOT_PENDING) return m.onboarding_wizard_error_not_pending();
  }
  return agentCreateErrorMessage(cause);
}
