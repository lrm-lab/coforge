import type { RuntimeRescanResult } from "./computer-detail-view";

/** What the Computer page says under the runtime list after a rescan the page asked for. */
export type RuntimeRescanNotice =
  | { kind: "none" }
  /** The daemon never answered in time: the Computer, not a runtime, is the problem. */
  | { kind: "timeout" }
  /** The daemon answered with a failure of its own; `message` is its sentence when it sent one. */
  | { kind: "error"; message?: string };

/**
 * Tells the outcomes apart, as the reference Computer does: no answer, or a failure the daemon
 * reported. A rescan that ran needs no line of its own — an unusable runtime's chip says so.
 */
export function runtimeRescanNotice(result: RuntimeRescanResult | undefined): RuntimeRescanNotice {
  if (!result) return { kind: "none" };
  if (result.status === "timeout") return { kind: "timeout" };
  if (result.status === "error") return { kind: "error", message: result.message };
  return { kind: "none" };
}
