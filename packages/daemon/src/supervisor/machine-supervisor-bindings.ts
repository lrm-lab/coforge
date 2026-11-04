import type { ManagedBinding, RestartResult } from "./machine-supervisor";

export const workspaceIdOf = (binding: ManagedBinding) => binding.workspaceId;

/** A binding as a stop leaves it: disabled, its unfinished restart recorded cancelled. */
export function stopped(binding: ManagedBinding): ManagedBinding {
  const cancelled = cancelledRestartResults(binding, "stop");
  return { ...binding, enabled: false, restart: undefined, restartResults: cancelled };
}

/** A binding's restart receipts with its unfinished restart, if any, recorded as cancelled by
 * this command. */
export function cancelledRestartResults(
  binding: ManagedBinding,
  by: "stop" | "configure",
): RestartResult[] | undefined {
  if (!binding.restart) return binding.restartResults;
  return appendRestartResult(binding, {
    requestId: binding.restart.requestId,
    status: "cancelled",
    by,
  });
}

/** A binding's restart receipts with one more, keeping the newest 128. */
export function appendRestartResult(
  binding: ManagedBinding,
  result: RestartResult,
): RestartResult[] {
  return [...(binding.restartResults ?? []), result].slice(-128);
}
