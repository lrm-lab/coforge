import { runtimeProviderLabel } from "#src/features/agents/runtime-provider-display";
import { formatList } from "#src/lib/format-list";
import { m } from "#src/paraglide/messages";
import type { RuntimeRescanNotice } from "./runtime-rescan-notice";
import { runtimeUnavailableReason } from "./runtime-unavailable-reason";

export function RuntimeRescanFeedback({ notice }: { notice: RuntimeRescanNotice }) {
  if (notice.kind === "none") return null;
  if (notice.kind !== "reported")
    return (
      <p className="mt-1 text-sm text-error-primary" role="alert">
        {m.computer_runtime_rescan_failed()}
      </p>
    );
  return (
    <>
      {notice.refreshed.length > 0 && (
        <p className="mt-1 text-sm text-tertiary" role="status">
          {m.computer_runtime_rescan_refreshed({
            runtimes: formatList(notice.refreshed.map(runtimeProviderLabel)),
          })}
        </p>
      )}
      {notice.failures.length > 0 && (
        <ul className="mt-1 space-y-1 text-sm text-error-primary" role="alert">
          {notice.failures.map(({ provider, code, diagnostic }) => (
            <li key={provider} className="wrap-anywhere">
              {m.computer_runtime_rescan_provider_failed({
                runtime: runtimeProviderLabel(provider),
                reason:
                  code && code !== "unknown"
                    ? runtimeUnavailableReason(code, diagnostic)
                    : diagnostic || m.computer_runtime_rescan_unknown(),
              })}
            </li>
          ))}
        </ul>
      )}
      {notice.signedOut.length > 0 && (
        <p className="mt-1 text-sm text-tertiary" role="status">
          {m.computer_runtime_rescan_sign_in({
            runtimes: formatList(notice.signedOut.map(runtimeProviderLabel)),
          })}
        </p>
      )}
    </>
  );
}
