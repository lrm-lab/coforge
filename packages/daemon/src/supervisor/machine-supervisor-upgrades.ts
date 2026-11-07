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
 * Opens one upgrade operation for a Workspace-scoped request. Returns whether this call is the
 * one that must launch the external job; a replay of the same request ID returns false. The
 * operation itself is machine-wide (see `recordUpgradeOperation`).
 */
export async function recordWorkspaceUpgrade(
  context: MachineUpgradeContext,
  workspaceId: string,
  requestId: string,
  expectedVersion: string,
): Promise<boolean> {
  await context.refresh();
  if (!context.bindings().some((entry) => entry.workspaceId === workspaceId))
    throw new Error("Workspace is not registered locally");
  return recordUpgradeOperation(context, requestId, expectedVersion);
}

/**
 * The shared admission half of `recordWorkspaceUpgrade`. An upgrade
 * replaces the installation every binding shares, so the single pending slot and the operation
 * record are machine-wide: the pending scan covers every binding (a binding added mid-upgrade is
 * still protected, its own request finds the pending copies elsewhere), and the new pending
 * record fans out onto every existing binding so no single binding's deletion can lose it.
 * Operations are mutually exclusive: a second request while another is still pending is
 * rejected outright rather than left to collide over the installation lock.
 */
async function recordUpgradeOperation(
  context: MachineUpgradeContext,
  requestId: string,
  expectedVersion: string,
): Promise<boolean> {
  if (!expectedVersion) throw new Error("upgrade expected version is required");
  const existing = context
    .bindings()
    .flatMap((binding) => binding.upgradeOperations ?? [])
    .find((entry) => entry.requestId === requestId);
  if (existing) {
    if (existing.expectedVersion !== expectedVersion)
      throw new Error("upgrade request already has a different expected version");
    return false;
  }
  // One entry per pending request ID, whichever binding carries it first: the settle check
  // reads the request's receipt, which is machine-level, so the copies need checking once.
  const pending = new Map<string, { workspaceId: string; requestedAt: number }>();
  for (const binding of context.bindings())
    for (const entry of binding.upgradeOperations ?? [])
      if (entry.state === "pending" && !pending.has(entry.requestId))
        pending.set(entry.requestId, {
          workspaceId: binding.workspaceId,
          requestedAt: entry.requestedAt,
        });
  for (const [pendingRequestId, carrier] of pending) {
    // A settle-able pending slot (its job left a receipt, or it aged past the TTL) must not
    // refuse a new request forever; only an in-flight operation blocks. `settlePendingUpgrade`
    // only reads; this applies it in the same mutation, not via `completeUpgrade`.
    const settlement = await context.settlePendingUpgrade?.(
      carrier.workspaceId,
      pendingRequestId,
      carrier.requestedAt,
    ).catch((error) => {
      logger.warn("Settling a pending Computer upgrade operation failed; still refusing", {
        event: "upgrade:pending_settle_check_failed",
        request_id: pendingRequestId,
        workspace_id: carrier.workspaceId,
        error_message: thrownMessage(error),
      });
      return undefined;
    });
    if (!settlement)
      throw new UpgradeOperationPendingError(
        `Computer upgrade operation ${pendingRequestId} is still pending; wait for it to finish before starting another`,
      );
    const { status, ...terminal } = settlement;
    for (const binding of [...context.bindings()]) {
      const operation = binding.upgradeOperations?.find(
        (entry) => entry.requestId === pendingRequestId && entry.state === "pending",
      );
      if (!operation) continue;
      await context.saveBinding({
        ...binding,
        upgradeOperations: binding.upgradeOperations!.map((entry) =>
          entry.requestId === pendingRequestId && entry.state === "pending"
            ? { ...entry, state: status, terminal }
            : entry,
        ),
      });
      logger.info("Computer upgrade operation reached its terminal state", {
        event: "upgrade:operation_settled",
        request_id: pendingRequestId,
        workspace_id: binding.workspaceId,
        status,
        ...(terminal.errorCode ? { error_code: terminal.errorCode } : {}),
      });
    }
  }
  const requestedAt = context.now();
  for (const binding of [...context.bindings()]) {
    await context.saveBinding({
      ...binding,
      upgradeOperations: [
        ...(binding.upgradeOperations ?? []),
        { requestId, expectedVersion, state: "pending" as const, requestedAt },
      ].slice(-UPGRADE_OPERATION_HISTORY),
    });
  }
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
