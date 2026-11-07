import type { ManagedBinding } from "./machine-supervisor";
import { stopped } from "./machine-supervisor-bindings";

/**
 * A stop's durable intent over its Workspaces, ahead of the stop's own turn in the serialized
 * queue: the Workspaces are persisted as stopped immediately, and every later save of them
 * keeps them stopped until this stop's sequence ends the hold. `MachineSupervisor` supplies
 * the context; the functions run inside its mutation queue.
 */
export type MachineStopIntentContext = {
  stopIntents: Map<string, number>;
  bindings(): ManagedBinding[];
  reloadIfRequired(): Promise<void>;
  exclusive<T>(write: () => Promise<T>): Promise<T>;
  store(next: ManagedBinding[]): Promise<void>;
};

/** Persists these Workspaces as stopped now, ahead of the stop's turn in the queue. */
export async function persistStopIntent(
  context: MachineStopIntentContext,
  workspaceIds: readonly string[],
  sequence: number,
): Promise<void> {
  for (const id of workspaceIds) context.stopIntents.set(id, sequence);
  try {
    await context.exclusive(async () => {
      await context.reloadIfRequired();
      const next = context.bindings().map((binding) =>
        context.stopIntents.has(binding.workspaceId) ? stopped(binding) : binding,
      );
      await context.store(next);
    });
  } catch (error) {
    // The stop fails as a whole (its queued turn sees the same error), so nothing stays forced.
    releaseStopIntent(context, workspaceIds, sequence);
    throw error;
  }
}

/** Ends this stop's hold over its Workspaces, unless a later stop took them over since. */
export function releaseStopIntent(
  context: MachineStopIntentContext,
  workspaceIds: readonly string[],
  sequence: number,
): void {
  for (const id of workspaceIds)
    if (context.stopIntents.get(id) === sequence) context.stopIntents.delete(id);
}
