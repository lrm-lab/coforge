import { getLogger } from "@logtape/logtape";
import { thrownMessage } from "@lrm/coforge-sdk/internal";
import type { ManagedBinding } from "./machine-supervisor";
import { UpgradeOperationPendingError } from "./upgrade-error";
import {
  UPGRADE_OPERATION_HISTORY,
  type PendingUpgradeSettler,
  type UpgradeOperationTerminal,
} from "./machine-supervisor-operations";

const logger = getLogger(["coforge", "daemon", "supervisor", "upgrades"]);

/**
 * What the persisted Computer upgrade operations need of the Coordinator's serialized mutation
 * context: a fresh read of the bindings, the guarded single-binding save, the optional pending
 * settler, and the clock. `MachineSupervisor` supplies it; the functions run inside its
 * `#serialize` queue, so they never take the lock themselves.
 */
export type MachineUpgradeContext = {
  refresh(): Promise<void>;
  bindings(): ManagedBinding[];
  saveBinding(binding: ManagedBinding): Promise<ManagedBinding>;
  settlePendingUpgrade?: PendingUpgradeSettler;
  now(): number;
};

/**
 * Opens one upgrade operation. Returns whether this call is the one that must launch the
 * external job; a replay of the same request ID returns false. Operations are mutually
 * exclusive: a second request while another is still pending is rejected outright rather than
 * left to collide over the installation lock.
 */
export async function recordWorkspaceUpgrade(
  context: MachineUpgradeContext,
  workspaceId: string,
  requestId: string,
  expectedVersion: string,
): Promise<boolean> {
  await context.refresh();
  const binding = context.bindings().find((entry) => entry.workspaceId === workspaceId);
  if (!binding) throw new Error("Workspace is not registered locally");
  if (!expectedVersion) throw new Error("upgrade expected version is required");
  let operations = binding.upgradeOperations ?? [];
  const existing = operations.find((entry) => entry.requestId === requestId);
  if (existing) {
    if (existing.expectedVersion !== expectedVersion)
      throw new Error("upgrade request already has a different expected version");
    return false;
  }
  const pending = operations.find((entry) => entry.state === "pending");
  if (pending) {
    // A settle-able pending slot (its job left a receipt, or it aged past the TTL) must not
    // refuse a new request forever; only an in-flight operation blocks. `settlePendingUpgrade`
    // only reads; this applies it in the same mutation, not via `completeUpgrade`.
    const settlement = await context.settlePendingUpgrade?.(
      workspaceId,
      pending.requestId,
      pending.requestedAt,
    ).catch((error) => {
      logger.warn("Settling a pending Computer upgrade operation failed; still refusing", {
        event: "upgrade:pending_settle_check_failed",
        request_id: pending.requestId,
        workspace_id: workspaceId,
        error_message: thrownMessage(error),
      });
      return undefined;
    });
    if (!settlement)
      throw new UpgradeOperationPendingError(
        `Computer upgrade operation ${pending.requestId} is still pending; wait for it to finish before starting another`,
      );
    const { status, ...terminal } = settlement;
    operations = operations.map((entry) =>
      entry.requestId === pending.requestId ? { ...entry, state: status, terminal } : entry,
    );
    logger.info("Computer upgrade operation reached its terminal state", {
      event: "upgrade:operation_settled",
      request_id: pending.requestId,
      workspace_id: workspaceId,
      status,
      ...(terminal.errorCode ? { error_code: terminal.errorCode } : {}),
    });
  }
  await context.saveBinding({
    ...binding,
    upgradeOperations: [
      ...operations,
      { requestId, expectedVersion, state: "pending" as const, requestedAt: context.now() },
    ].slice(-UPGRADE_OPERATION_HISTORY),
  });
  return true;
}

/** Records the durable receipt an operation's external job left behind. */
export async function completeWorkspaceUpgrade(
  context: MachineUpgradeContext,
  workspaceId: string,
  requestId: string,
  terminal: { status: "succeeded" | "failed" } & UpgradeOperationTerminal,
): Promise<boolean> {
  await context.refresh();
  const binding = context.bindings().find((entry) => entry.workspaceId === workspaceId);
  const operation = binding?.upgradeOperations?.find((entry) => entry.requestId === requestId);
  if (!binding || !operation || operation.state !== "pending") return false;
  const { status, ...receipt } = terminal;
  await context.saveBinding({
    ...binding,
    upgradeOperations: binding.upgradeOperations!.map((entry) =>
      entry.requestId === requestId ? { ...entry, state: status, terminal: receipt } : entry,
    ),
  });
  return true;
}

/** The server accepted the reported result; the record becomes audit-only history. */
export async function acknowledgeWorkspaceUpgrade(
  context: MachineUpgradeContext,
  workspaceId: string,
  requestId: string,
): Promise<boolean> {
  await context.refresh();
  const binding = context.bindings().find((entry) => entry.workspaceId === workspaceId);
  const operation = binding?.upgradeOperations?.find((entry) => entry.requestId === requestId);
  if (!binding || !operation) return false;
  if (operation.state === "acknowledged") return true;
  if (operation.state === "pending")
    throw new Error("a pending Computer upgrade operation cannot be acknowledged");
  await context.saveBinding({
    ...binding,
    upgradeOperations: binding.upgradeOperations!.map((entry) =>
      entry.requestId === requestId ? { ...entry, state: "acknowledged" as const } : entry,
    ),
  });
  return true;
}
