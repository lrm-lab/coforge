import type { RuntimeProvider, RuntimeUnavailableCode } from "@lrm/coforge-sdk/internal";

import type { RuntimeRescanResult } from "./computer-detail-view";

/** What the Computer page says under the runtime list after a rescan the page asked for. */
export type RuntimeRescanNotice =
  | { kind: "none" }
  /** The daemon never answered in time: the Computer, not a runtime, is the problem. */
  | { kind: "timeout" }
  /** The daemon answered with a failure of its own; `message` is its sentence when it sent one. */
  | { kind: "error"; message?: string }
  /** The rescan ran, but at least one runtime is installed and cannot be used. */
  | { kind: "partial" };

/**
 * Tells the three outcomes apart, as the reference Computer does: no answer, a failure the daemon
 * reported, or a rescan that ran and left a runtime unusable (whose reason each row shows).
 */
export function runtimeRescanNotice(
  result: RuntimeRescanResult | undefined,
  runtimes: readonly {
    provider: RuntimeProvider;
    unavailableCode?: RuntimeUnavailableCode | null;
  }[],
): RuntimeRescanNotice {
  if (!result) return { kind: "none" };
  if (result.status === "timeout") return { kind: "timeout" };
  if (result.status === "error") return { kind: "error", message: result.message };
  return runtimes.some((runtime) => runtime.unavailableCode)
    ? { kind: "partial" }
    : { kind: "none" };
}
