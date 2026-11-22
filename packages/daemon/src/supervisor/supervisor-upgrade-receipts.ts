import { type Logger } from "@logtape/logtape";
import { thrownMessage } from "@lrm/coforge-sdk/internal";
import {
  sweepComputerUpgradeReceipts,
  upgradeTerminalOf,
  watchComputerUpgradeReceipt,
  type ComputerUpgradeReceipt,
} from "#src/platform/computer-upgrade-receipts";
import { type MachineSupervisor, UPGRADE_OPERATION_PENDING_TTL_MS } from "./machine-supervisor";

const UPGRADE_RECEIPT_POLL_MS = 2_000;

export function supervisorUpgradeReceipts(
  supervisor: MachineSupervisor,
  supervisorLogger: Logger,
  refreshChildUpgradeConfig: (workspaceId: string) => Promise<void>,
) {
  const completeUpgrade = async (
    workspaceId: string,
    requestId: string,
    receipt: ComputerUpgradeReceipt,
  ) => {
    const recorded = await supervisor.completeUpgrade(
      workspaceId,
      requestId,
      upgradeTerminalOf(receipt),
    );
    if (recorded) {
      supervisorLogger.info("Computer upgrade operation reached its terminal state", {
        event: "upgrade:operation_settled",
        request_id: requestId,
        workspace_id: workspaceId,
        status: receipt.status,
        ...(receipt.errorCode ? { error_code: receipt.errorCode } : {}),
      });
      // A replacement child reports it on ready; a running child on its next poll.
      await refreshChildUpgradeConfig(workspaceId);
    }
    return recorded;
  };
  const pendingUpgradeOperations = async () =>
    (await supervisor.snapshot()).flatMap((binding) =>
      (binding.upgradeOperations ?? [])
        .filter((operation) => operation.state === "pending")
        .map((operation) => ({
          workspaceId: binding.workspaceId,
          requestId: operation.requestId,
          requestedAt: operation.requestedAt,
        })),
    );
  const settlePendingUpgradeOperations = async () => {
    try {
      // A stranded operation is aged out here too: without that, one lost receipt would refuse
      // every later upgrade on this machine.
      await sweepComputerUpgradeReceipts(await pendingUpgradeOperations(), completeUpgrade, {
        pendingTtlMs: UPGRADE_OPERATION_PENDING_TTL_MS,
      });
    } catch (error) {
      supervisorLogger.error("Computer upgrade receipt sweep failed", {
        event: "upgrade:receipt_sweep_failed",
        error_message: thrownMessage(error),
      });
    }
  };
  /**
   * Keeps watching one pending operation - either one this process launched, or crash-recovery
   * state whose receipt was not yet available - until its receipt is written or its TTL expires.
   * It shares the TTL of startup sweeping and is cancelled at shutdown through
   * `upgradeWatchController`.
   */
  const upgradeWatchController = new AbortController();
  const upgradeWatches = new Set<Promise<void>>();
  const watchPendingUpgrade = (workspaceId: string, requestId: string, requestedAt: number) => {
    const watch = watchComputerUpgradeReceipt(
      { workspaceId, requestId, requestedAt },
      completeUpgrade,
      {
        signal: upgradeWatchController.signal,
        pollMs: UPGRADE_RECEIPT_POLL_MS,
        ttlMs: UPGRADE_OPERATION_PENDING_TTL_MS,
      },
    ).catch((error) =>
      supervisorLogger.error("Computer upgrade receipt watch failed", {
        event: "upgrade:receipt_watch_failed",
        workspace_id: workspaceId,
        request_id: requestId,
        error_message: thrownMessage(error),
      }),
    );
    upgradeWatches.add(watch);
    void watch.finally(() => upgradeWatches.delete(watch));
  };
  return {
    completeUpgrade,
    pendingUpgradeOperations,
    settlePendingUpgradeOperations,
    watchPendingUpgrade,
    async stop() {
      upgradeWatchController.abort();
      await Promise.allSettled(upgradeWatches);
    },
  };
}
