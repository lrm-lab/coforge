import { ProgressSteps } from "#src/components/ui/progress-steps";
import { runtimeProviderLabel } from "#src/features/agents/runtime-provider-display";
import { m } from "#src/paraglide/messages";
import type { ConnectionCheck } from "./onboarding-wizard-plan";

function checkTitle(check: ConnectionCheck): string {
  const done = check.status === "complete";
  switch (check.id) {
    case "approved":
      return done ? m.onboarding_wizard_check_approved() : m.onboarding_wizard_check_approving();
    case "connected":
      return done
        ? m.onboarding_wizard_check_connected({ name: check.name ?? "" })
        : m.onboarding_wizard_check_connecting();
    case "runtime":
      return done
        ? m.onboarding_wizard_check_runtime({
            names: check.providers.map(runtimeProviderLabel).join(", "),
          })
        : m.onboarding_wizard_check_detecting();
  }
}

/** The live list under a local computer choice (a polite live region, so ticks are announced): a check for what is true, a spinner for the line
 * being waited on, an empty mark for the ones after it. */
export function ConnectionChecks({ checks }: { checks: readonly ConnectionCheck[] }) {
  return (
    <div role="status" className="rounded-xl border border-secondary bg-secondary px-4 py-3.5">
      <ProgressSteps
        spinner
        items={checks.map((check) => ({ title: checkTitle(check), status: check.status }))}
        className="gap-2.5"
      />
    </div>
  );
}
