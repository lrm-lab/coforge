import type { ManagedRuntimeIdentity } from "@lrm/coforge-sdk/internal";
import type { ManagedBinding } from "./machine-supervisor";

/** A binding as `MachineSupervisor.snapshot()`/`view()` report it: with its live OS instance. */
export type ObservedBinding = Pick<ManagedBinding, "workspaceId" | "computerId" | "enabled"> & {
  instanceId: string | null;
  /** A start, restart, or configure of this Workspace is queued or running. */
  inFlight: boolean;
};

/** A Workspace daemon child the Coordinator adopted: its handshake and its OS invocation. */
export type AdoptedChild = { identity: ManagedRuntimeIdentity; osInstanceId: string };

/**
 * What the Coordinator reports for one Workspace: the adopted child's handshake identity while
 * that child is still the live OS instance, otherwise a down Workspace (with why it is parked, if
 * it is).
 */
export async function workspaceRuntimeView(
  binding: ObservedBinding,
  child: AdoptedChild | undefined,
  parkReason: (workspaceId: string) => Promise<string | undefined>,
): Promise<ManagedRuntimeIdentity> {
  // A start, restart, or configure queued or running: an upgrade waits for it instead of
  // reading the Workspace as down, and the CLI reports it as still starting.
  const underWay = binding.inFlight ? { lifecycleUnderWay: true } : {};
  if (child && binding.instanceId === child.osInstanceId)
    return { ...child.identity, enabled: binding.enabled, ...underWay };
  // Only a Workspace that is down can be parked.
  const reason = await parkReason(binding.workspaceId);
  const parked = reason ? { parkReason: reason } : {};
  return {
    workspaceId: binding.workspaceId,
    computerId: binding.computerId,
    enabled: binding.enabled,
    processId: 0,
    instanceId: "",
    version: "",
    ...parked,
    ...underWay,
  };
}
