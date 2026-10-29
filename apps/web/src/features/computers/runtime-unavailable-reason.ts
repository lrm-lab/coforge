import type { RuntimeUnavailableCode } from "@lrm/coforge-sdk/internal";

import { m } from "#src/paraglide/messages";

/**
 * Why an installed runtime cannot be used, in the reader's language. The daemon's `diagnostic` is
 * the CLI's own redacted stderr line and follows verbatim: it says what the launcher hit far
 * better than a sentence we could write, and it is never translated.
 */
export function runtimeUnavailableReason(
  unavailableCode: RuntimeUnavailableCode,
  diagnostic?: string | null,
): string {
  const reason =
    unavailableCode === "version_unsupported"
      ? m.computer_runtime_unavailable_version_unsupported()
      : unavailableCode === "start_failed"
        ? m.computer_runtime_unavailable_start_failed()
        : unavailableCode === "probe_failed"
          ? m.computer_runtime_unavailable_probe_failed()
          : m.computer_runtime_unavailable_unknown();
  return diagnostic ? `${reason} (${diagnostic})` : reason;
}
