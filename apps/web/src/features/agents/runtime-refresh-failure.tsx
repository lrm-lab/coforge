import type { RuntimeUnavailableCode } from "@lrm/coforge-sdk/internal";
import { m } from "#src/paraglide/messages";
import { runtimeUnavailableReason } from "#src/features/computers/runtime-unavailable-reason";

/** The line under the model selector after a failed catalog refresh: the runtime's classified
 * reason when the daemon sent one, else the generic retry hint. */
export function RuntimeRefreshFailure({
  failure,
}: {
  failure: { code?: RuntimeUnavailableCode; diagnostic?: string };
}) {
  return (
    <p role="alert" className="text-sm text-error-primary">
      {failure.code
        ? runtimeUnavailableReason(failure.code, failure.diagnostic)
        : m.agent_form_model_refresh_failed()}
    </p>
  );
}
