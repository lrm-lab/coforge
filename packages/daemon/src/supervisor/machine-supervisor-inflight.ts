import { WorkspaceLifecycleSupersededError } from "./lifecycle-superseded-error";
import type { ManagedBinding } from "./machine-supervisor";

/**
 * The in-flight bookkeeping every operator command shares: which start/restart work a stop or
 * configure supersedes, which Workspaces a command has under way, and the abort handles the
 * serialized work runs under. `MachineSupervisor` supplies the context; the maps are shared by
 * reference so `view()` and `#command` keep reading them directly.
 */
export type MachineInFlightContext = {
  bindings(): ManagedBinding[];
  inFlight: Map<string, AbortController>;
  underWay: Map<string, number>;
  supersededAt: Map<string, { sequence: number; by: "stop" | "configure" }>;
  nextSequence(): number;
};

/** Takes over the start/restart work of these Workspaces requested so far; returns this
 * request's sequence. */
export function supersedeWorkspaceWork(
  context: MachineInFlightContext,
  workspaceIds: readonly string[],
  by: "stop" | "configure",
): number {
  const sequence = context.nextSequence();
  for (const id of workspaceIds) {
    context.supersededAt.set(id, { sequence, by });
    context.inFlight.get(id)?.abort(new WorkspaceLifecycleSupersededError(id, by));
  }
  return sequence;
}

/** Marks these Workspaces under way until each is settled (or all are, once the work ends). */
export function markWorkspacesUnderWay(
  context: MachineInFlightContext,
  workspaceIds: readonly string[],
): { one: (id: string) => void; all: () => void } {
  const marked = new Set(workspaceIds);
  for (const id of marked) context.underWay.set(id, (context.underWay.get(id) ?? 0) + 1);
  const one = (id: string) => {
    if (!marked.delete(id)) return;
    const count = (context.underWay.get(id) ?? 1) - 1;
    if (count > 0) context.underWay.set(id, count);
    else context.underWay.delete(id);
  };
  return { one, all: () => [...marked].forEach(one) };
}

/** Runs one Workspace's start/restart work where a stop or configure can abort it. */
export async function trackWorkspaceWork<T>(
  context: MachineInFlightContext,
  workspaceId: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  context.inFlight.set(workspaceId, controller);
  try {
    return await run(controller.signal);
  } finally {
    if (context.inFlight.get(workspaceId) === controller) context.inFlight.delete(workspaceId);
  }
}

/** The Workspaces a command acts on: an unscoped restart leaves disabled bindings alone. */
export function commandTargets(
  context: MachineInFlightContext,
  operation: "start" | "stop" | "restart",
  workspaceId?: string,
): ManagedBinding[] {
  return context
    .bindings()
    .filter(
      (binding) =>
        (!workspaceId || binding.workspaceId === workspaceId) &&
        !(operation === "restart" && !workspaceId && !binding.enabled),
    );
}
